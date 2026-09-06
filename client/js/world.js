// ============================================
// School Battle - 町フィールド (world.js)
// ============================================
// ・Canvasで描画する2Dトップダウンの町フィールド
// ・WASD / 矢印キー / 画面上の十字キーで自由移動
// ・Socket.IOで他プレイヤーの位置をリアルタイムに同期
// ・建物に近づいてEnter（またはタップ）すると、既存の
//   ショップ／勉強／オンライン対戦などの画面がそのまま開く
// ============================================

(function () {
    const WORLD_ID = "town_main";
    const WORLD_W = 1600;
    const WORLD_H = 1000;
    const MOVE_SPEED = 210; // px/sec
    const INTERACT_RADIUS = 70;
    const MOVE_SEND_INTERVAL = 90; // ms

    // 建物定義：既存のサイドバー機能をそのまま「町の設備」として配置する
    const BUILDINGS = [
        { id: "inn", section: "stats", label: "宿屋（ステータス）", icon: "🏠", x: 180, y: 180, w: 140, h: 110, color: "#8d6e63" },
        { id: "school", section: "study", label: "学習所", icon: "📖", x: 460, y: 140, w: 140, h: 110, color: "#5b9bd5" },
        { id: "board", section: "missions", label: "掲示板（ミッション）", icon: "🎯", x: 760, y: 160, w: 130, h: 100, color: "#ffc107" },
        { id: "shop", section: "shop", label: "武器屋・道具屋", icon: "🛒", x: 1040, y: 150, w: 150, h: 110, color: "#c9812f" },
        { id: "dojo", section: "skills", label: "修行場（スキル）", icon: "⚔️", x: 1300, y: 200, w: 140, h: 110, color: "#9b59b6" },
        { id: "arena", section: "online", label: "闘技場（オンライン対戦）", icon: "🌐", x: 1300, y: 520, w: 160, h: 120, color: "#e85a7a" },
        { id: "shrine", section: "boss-battle", label: "ボスの祠", icon: "👹", x: 1020, y: 600, w: 150, h: 110, color: "#4a3b6b" },
        { id: "records", section: "ranking", label: "記録所（ランキング）", icon: "🏆", x: 740, y: 640, w: 140, h: 100, color: "#3ddc84" },
        { id: "guild", section: "guild", label: "ギルドホール", icon: "🏰", x: 460, y: 610, w: 150, h: 110, color: "#6a5acd" },
        { id: "info", section: "help", label: "案内所", icon: "❓", x: 200, y: 560, w: 120, h: 100, color: "#607d8b" }
    ];

    const SPAWN = { x: WORLD_W / 2, y: WORLD_H / 2 };

    let canvas, ctx, prompt, playerListEl, interactBtn;
    let viewportW = 800, viewportH = 500;

    let joined = false;
    let joinInFlight = false;
    let sectionActive = false;
    let rafId = null;
    let lastFrameTime = null;
    let lastSendTime = 0;
    let lastSentX = null, lastSentY = null, lastSentDir = null;

    const local = { x: SPAWN.x, y: SPAWN.y, dir: "down", moving: false };
    // リモートプレイヤー: id -> { name, level, x, y, dir, targetX, targetY }
    const remotePlayers = {};

    const keys = { up: false, down: false, left: false, right: false };
    const dpadKeys = { up: false, down: false, left: false, right: false };

    function colorForId(id) {
        let hash = 0;
        for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
        const hue = hash % 360;
        return `hsl(${hue}, 62%, 55%)`;
    }

    function getMyPlayer() {
        try {
            return typeof getPlayerData === "function" ? getPlayerData() : null;
        } catch (e) {
            return null;
        }
    }

    function initDom() {
        canvas = document.getElementById("townCanvas");
        if (!canvas) return false;
        ctx = canvas.getContext("2d");
        prompt = document.getElementById("townPrompt");
        playerListEl = document.getElementById("townPlayerList");
        interactBtn = document.getElementById("townInteractBtn");
        viewportW = canvas.width;
        viewportH = canvas.height;

        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);

        canvas.addEventListener("click", onCanvasClick);

        if (interactBtn) {
            interactBtn.addEventListener("click", () => {
                const b = findNearbyBuilding();
                if (b) enterBuilding(b);
            });
        }

        document.querySelectorAll(".town-dpad-btn").forEach(btn => {
            const dir = btn.dataset.dir;
            const setState = (v) => { dpadKeys[dir] = v; };
            btn.addEventListener("touchstart", (e) => { e.preventDefault(); setState(true); }, { passive: false });
            btn.addEventListener("touchend", (e) => { e.preventDefault(); setState(false); }, { passive: false });
            btn.addEventListener("mousedown", () => setState(true));
            btn.addEventListener("mouseup", () => setState(false));
            btn.addEventListener("mouseleave", () => setState(false));
        });

        return true;
    }

    function onKeyDown(e) {
        if (!sectionActive) return;
        switch (e.key) {
            case "w": case "W": case "ArrowUp": keys.up = true; break;
            case "s": case "S": case "ArrowDown": keys.down = true; break;
            case "a": case "A": case "ArrowLeft": keys.left = true; break;
            case "d": case "D": case "ArrowRight": keys.right = true; break;
            case "Enter": case " ": {
                const b = findNearbyBuilding();
                if (b) enterBuilding(b);
                break;
            }
        }
    }

    function onKeyUp(e) {
        switch (e.key) {
            case "w": case "W": case "ArrowUp": keys.up = false; break;
            case "s": case "S": case "ArrowDown": keys.down = false; break;
            case "a": case "A": case "ArrowLeft": keys.left = false; break;
            case "d": case "D": case "ArrowRight": keys.right = false; break;
        }
    }

    function onCanvasClick(e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const clickX = (e.clientX - rect.left) * scaleX + camera().x;
        const clickY = (e.clientY - rect.top) * scaleY + camera().y;

        for (const b of BUILDINGS) {
            if (clickX >= b.x && clickX <= b.x + b.w && clickY >= b.y && clickY <= b.y + b.h) {
                enterBuilding(b);
                return;
            }
        }
    }

    function enterBuilding(building) {
        if (typeof window.activateSection === "function") {
            window.activateSection(building.section);
        }
    }

    function findNearbyBuilding() {
        let closest = null;
        let closestDist = Infinity;
        for (const b of BUILDINGS) {
            const cx = b.x + b.w / 2;
            const cy = b.y + b.h + 10; // 入口はだいたい建物の手前（下側）
            const d = Math.hypot(local.x - cx, local.y - cy);
            if (d < INTERACT_RADIUS && d < closestDist) {
                closest = b;
                closestDist = d;
            }
        }
        return closest;
    }

    function camera() {
        let cx = local.x - viewportW / 2;
        let cy = local.y - viewportH / 2;
        cx = Math.max(0, Math.min(WORLD_W - viewportW, cx));
        cy = Math.max(0, Math.min(WORLD_H - viewportH, cy));
        return { x: cx, y: cy };
    }

    function collidesWithBuilding(x, y) {
        const r = 16; // プレイヤーの当たり判定半径
        for (const b of BUILDINGS) {
            if (x + r > b.x && x - r < b.x + b.w && y + r > b.y && y - r < b.y + b.h) {
                return true;
            }
        }
        return false;
    }

    function updateLocalMovement(dt) {
        const up = keys.up || dpadKeys.up;
        const down = keys.down || dpadKeys.down;
        const left = keys.left || dpadKeys.left;
        const right = keys.right || dpadKeys.right;

        let dx = 0, dy = 0;
        if (up) dy -= 1;
        if (down) dy += 1;
        if (left) dx -= 1;
        if (right) dx += 1;

        local.moving = dx !== 0 || dy !== 0;

        if (local.moving) {
            const len = Math.hypot(dx, dy) || 1;
            dx /= len; dy /= len;

            if (Math.abs(dx) > Math.abs(dy)) {
                local.dir = dx > 0 ? "right" : "left";
            } else {
                local.dir = dy > 0 ? "down" : "up";
            }

            const nx = local.x + dx * MOVE_SPEED * dt;
            const ny = local.y + dy * MOVE_SPEED * dt;

            const margin = 16;
            const clampedX = Math.max(margin, Math.min(WORLD_W - margin, nx));
            const clampedY = Math.max(margin, Math.min(WORLD_H - margin, ny));

            // X軸・Y軸を別々に判定して、壁沿いに滑れるようにする
            if (!collidesWithBuilding(clampedX, local.y)) local.x = clampedX;
            if (!collidesWithBuilding(local.x, clampedY)) local.y = clampedY;
        }
    }

    function maybeSendPosition() {
        const now = Date.now();
        if (now - lastSendTime < MOVE_SEND_INTERVAL) return;
        if (local.x === lastSentX && local.y === lastSentY && local.dir === lastSentDir) return;
        if (!window.socket || !window.socket.connected) return;

        const player = getMyPlayer();
        if (!player || !player.id) return;

        window.socket.emit("world:move", {
            worldId: WORLD_ID,
            playerId: player.id,
            x: local.x,
            y: local.y,
            dir: local.dir
        });

        lastSendTime = now;
        lastSentX = local.x; lastSentY = local.y; lastSentDir = local.dir;
    }

    function updateRemoteInterpolation(dt) {
        for (const id in remotePlayers) {
            const p = remotePlayers[id];
            const t = Math.min(1, dt * 10);
            p.x += (p.targetX - p.x) * t;
            p.y += (p.targetY - p.y) * t;
        }
    }

    function drawBackground(cam) {
        ctx.fillStyle = "#2f5233";
        ctx.fillRect(0, 0, viewportW, viewportH);

        // 簡易的な地面のタイル模様
        const tile = 40;
        ctx.strokeStyle = "rgba(255,255,255,0.03)";
        ctx.lineWidth = 1;
        const offsetX = -cam.x % tile;
        const offsetY = -cam.y % tile;
        for (let x = offsetX; x < viewportW; x += tile) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, viewportH); ctx.stroke();
        }
        for (let y = offsetY; y < viewportH; y += tile) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(viewportW, y); ctx.stroke();
        }

        // 建物同士を結ぶ簡易的な道
        ctx.fillStyle = "#c9b894";
        ctx.globalAlpha = 0.35;
        for (const b of BUILDINGS) {
            const cx = b.x + b.w / 2 - cam.x;
            const cy = b.y + b.h - cam.y;
            ctx.beginPath();
            ctx.arc(cx, cy + 20, 46, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    function drawBuildings(cam) {
        for (const b of BUILDINGS) {
            const x = b.x - cam.x;
            const y = b.y - cam.y;
            if (x + b.w < 0 || x > viewportW || y + b.h < 0 || y > viewportH) continue;

            ctx.fillStyle = b.color;
            roundRect(x, y, b.w, b.h, 10);
            ctx.fill();
            ctx.strokeStyle = "rgba(0,0,0,0.35)";
            ctx.lineWidth = 2;
            roundRect(x, y, b.w, b.h, 10);
            ctx.stroke();

            ctx.font = "28px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(b.icon, x + b.w / 2, y + b.h / 2 + 10);

            ctx.font = "bold 12px sans-serif";
            ctx.fillStyle = "#ffffff";
            ctx.fillText(b.label, x + b.w / 2, y + b.h + 16);
        }
    }

    function roundRect(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function drawPlayer(x, y, color, name, level, dir, isMe) {
        ctx.save();
        // 影
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.beginPath();
        ctx.ellipse(x, y + 16, 14, 5, 0, 0, Math.PI * 2);
        ctx.fill();

        // 体
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = isMe ? "#ffffff" : "rgba(0,0,0,0.4)";
        ctx.lineWidth = isMe ? 2.5 : 1.5;
        ctx.stroke();

        // 向き（三角形）
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        const dirVec = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir] || [0, 1];
        const tipX = x + dirVec[0] * 18;
        const tipY = y + dirVec[1] * 18;
        const perpX = -dirVec[1] * 5;
        const perpY = dirVec[0] * 5;
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(x + perpX, y + perpY);
        ctx.lineTo(x - perpX, y - perpY);
        ctx.closePath();
        ctx.fill();

        // 名前ラベル
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "center";
        const label = `${name} Lv.${level || 1}`;
        const labelW = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(15,17,21,0.7)";
        roundRect(x - labelW / 2 - 5, y - 38, labelW + 10, 16, 6);
        ctx.fill();
        ctx.fillStyle = isMe ? "#3ddc84" : "#f0f2f5";
        ctx.fillText(label, x, y - 26);

        ctx.restore();
    }

    function updatePromptUI() {
        const b = findNearbyBuilding();
        if (b) {
            if (prompt) {
                prompt.style.display = "block";
                prompt.textContent = `Enterキーで「${b.label}」に入る`;
            }
            if (interactBtn) {
                interactBtn.style.display = "inline-flex";
                interactBtn.textContent = `入る（${b.label}）`;
            }
        } else {
            if (prompt) prompt.style.display = "none";
            if (interactBtn) interactBtn.style.display = "none";
        }
    }

    function updatePlayerListUI() {
        if (!playerListEl) return;
        const count = Object.keys(remotePlayers).length + 1;
        let html = `<strong>町にいる人数: ${count}</strong>`;
        playerListEl.innerHTML = html;
    }

    function render() {
        if (!ctx) return;
        const cam = camera();
        drawBackground(cam);
        drawBuildings(cam);

        for (const id in remotePlayers) {
            const p = remotePlayers[id];
            drawPlayer(p.x - cam.x, p.y - cam.y, colorForId(id), p.name, p.level, p.dir, false);
        }

        const player = getMyPlayer();
        drawPlayer(local.x - cam.x, local.y - cam.y, "#3ddc84", (player && player.name) || "あなた", player && player.level, local.dir, true);
    }

    function loop(timestamp) {
        if (!sectionActive) { rafId = null; return; }
        if (lastFrameTime == null) lastFrameTime = timestamp;
        const dt = Math.min(0.1, (timestamp - lastFrameTime) / 1000);
        lastFrameTime = timestamp;

        updateLocalMovement(dt);
        updateRemoteInterpolation(dt);
        maybeSendPosition();
        updatePromptUI();
        updatePlayerListUI();
        render();

        rafId = requestAnimationFrame(loop);
    }

    function startLoop() {
        if (rafId != null) return;
        lastFrameTime = null;
        rafId = requestAnimationFrame(loop);
    }

    function stopLoop() {
        if (rafId != null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        keys.up = keys.down = keys.left = keys.right = false;
        dpadKeys.up = dpadKeys.down = dpadKeys.left = dpadKeys.right = false;
    }

    function setupSocketListeners() {
        if (!window.socket) return;

        window.socket.on("world:state", (data) => {
            if (!data || data.worldId !== WORLD_ID) return;
            for (const key in remotePlayers) delete remotePlayers[key];
            (data.players || []).forEach(p => {
                remotePlayers[p.id] = { name: p.name, level: p.level, x: p.x, y: p.y, targetX: p.x, targetY: p.y, dir: p.dir || "down" };
            });
            if (data.me) {
                local.x = data.me.x;
                local.y = data.me.y;
                local.dir = data.me.dir || "down";
            }
        });

        window.socket.on("world:playerJoined", (p) => {
            if (!p || !p.id) return;
            const myPlayer = getMyPlayer();
            if (myPlayer && myPlayer.id === p.id) return;
            remotePlayers[p.id] = { name: p.name, level: p.level, x: p.x, y: p.y, targetX: p.x, targetY: p.y, dir: p.dir || "down" };
        });

        window.socket.on("world:playerMoved", (p) => {
            if (!p || !p.id) return;
            const existing = remotePlayers[p.id];
            if (existing) {
                existing.targetX = p.x;
                existing.targetY = p.y;
                existing.dir = p.dir || existing.dir;
            }
        });

        window.socket.on("world:playerLeft", (p) => {
            if (!p || !p.id) return;
            delete remotePlayers[p.id];
        });

        window.socket.on("connect", () => {
            // 再接続時は再度参加しなおす
            joined = false;
            tryJoinWorld();
        });
    }

    function tryJoinWorld() {
        if (joined || joinInFlight) return;
        if (!window.socket || !window.socket.connected) return;
        const player = getMyPlayer();
        if (!player || !player.id) return;

        joinInFlight = true;
        window.socket.emit("world:join", {
            worldId: WORLD_ID,
            player: { id: player.id, name: player.name, level: player.level },
            spawn: { x: local.x, y: local.y }
        });
        joined = true;
        joinInFlight = false;
    }

    // script.jsのメニュー切り替えから呼ばれる：町タブがアクティブになったか
    window.onTownSectionActivated = function (isActive) {
        sectionActive = isActive;
        if (isActive) {
            tryJoinWorld();
            startLoop();
        } else {
            stopLoop();
        }
    };

    function init() {
        if (!initDom()) return;
        setupSocketListeners();

        // ソケット・キャラクターがまだ準備できていないケースに備えて、
        // 準備が整うまで軽くポーリングして参加を試みる
        const readyPoll = setInterval(() => {
            if (window.socket && window.socket.connected && getMyPlayer()) {
                tryJoinWorld();
                if (joined) clearInterval(readyPoll);
            }
        }, 1500);
    }

    document.addEventListener("DOMContentLoaded", init);
})();
