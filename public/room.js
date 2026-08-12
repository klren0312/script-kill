const params = new URLSearchParams(location.search);
const gameId = params.get("game");
if (!gameId) location.replace("/");

const $ = (id) => document.getElementById(id);

const chatLog = $("chat-log");
const privateLog = $("private-log");
const turnBanner = $("turn-banner");
const phaseChip = $("phase-chip");
const resultDialog = $("result-dialog");

let snapshot = null;
let me = null;
let view = null; // scriptSelectView（角色/地点清单，用于调查与投票）
let busy = false;

// 将 API 快照字段（myPrivateEvents）归一到前端内部使用的 privateEvents。
function normalizeSnapshot(snap) {
	if (!snap) return snap;
	if (snap.myPrivateEvents !== undefined) {
		snap.privateEvents = snap.myPrivateEvents;
		delete snap.myPrivateEvents;
	}
	return snap;
}

const esc = (s) =>
	String(s ?? "").replace(/[&<>"']/g, (c) =>
		({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);

const PHASE_LABEL = {
	setup: "准备中",
	reading: "阅读阶段",
	discussion: "讨论阶段",
	voting: "投票阶段",
	reveal: "揭晓",
	finished: "已结束",
};

async function api(path, opts) {
	const res = await fetch(path, opts);
	const j = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(j.error ?? "请求失败");
	return j;
}

async function load() {
	try {
		me = await api(`/api/games/${gameId}/me`);
		snapshot = normalizeSnapshot(await api(`/api/games/${gameId}`));
		const script = await api(`/api/scripts/${encodeURIComponent(snapshot.scriptId)}`);
		view = script;
		$("room-title").textContent = script.title;
		render();
		openSse();
		if (snapshot.phase === "discussion") {
			// 若停在中途（刷新/重启后），恢复 AI 回合
			api(`/api/games/${gameId}/resume`, { method: "POST" }).catch(() => {});
		}
	} catch (err) {
		chatLog.innerHTML = `<div class="msg system">加载失败：${esc(err.message)}</div>`;
	}
}

// ---------- SSE ----------

function openSse() {
	const es = new EventSource(`/api/games/${gameId}/events`);
	es.onmessage = (msg) => {
		let ev;
		try {
			ev = JSON.parse(msg.data);
		} catch {
			return;
		}
		handleEvent(ev);
	};
	es.onerror = () => {
		// EventSource 会自动重连；服务端重连时会推送完整快照
	};
}

function handleEvent(ev) {
	if (!snapshot) return;
	if (ev.type === "snapshot") {
		snapshot = normalizeSnapshot(ev.snapshot);
		rebuildLogs();
		render();
		return;
	}
	if (ev.type === "phase") {
		snapshot.phase = ev.phase;
	}
	if (ev.type === "turn") {
		snapshot.currentTurn = ev.currentTurn;
		snapshot.round = ev.round ?? snapshot.round;
	}
	if (ev.type === "game_end") {
		snapshot.votes = ev.votes ?? snapshot.votes;
		snapshot.winner = ev.winner;
		snapshot.phase = "finished";
	}
	// 乐观更新替换检查：如果当前日志末尾是占位节点且与事件匹配，则替换。
	let handled = false;
	if (ev.scope === snapshot.humanRoleId) {
		handled = tryReplaceOptimistic(ev, privateLog, "private");
	}
	if (ev.scope === "public" || !ev.scope) {
		handled = tryReplaceOptimistic(ev, chatLog, "public");
	}
	if (handled) {
		render();
		return;
	}
	// 正常追加
	if (ev.scope === "public" || !ev.scope) {
		snapshot.publicEvents.push(ev);
		appendPublic(ev);
	} else if (ev.scope === snapshot.humanRoleId) {
		snapshot.privateEvents.push(ev);
		appendPrivate(ev);
	}
	render();
}

// ---------- 渲染 ----------

function render() {
	phaseChip.textContent = PHASE_LABEL[snapshot.phase] ?? snapshot.phase;
	renderRolePanel();
	renderTurn();
	renderActions();
	if (snapshot.phase === "finished" && !resultDialog.open && snapshot.winner) {
		showResult();
	}
}

function renderRolePanel() {
	if (!me) return;
	$("my-role-name").textContent = `你的角色：${me.role.name}`;
	$("my-role-public").textContent = me.role.public;
	$("my-role-secret").textContent = me.role.secret;
	$("my-role-goal").textContent = me.role.goal;
	const list = $("my-clues");
	list.innerHTML = "";
	const ownClues = me.clueTexts.filter((c) => !me.publicClues.some((p) => p.id === c.id));
	const publicClues = me.publicClues ?? [];
	for (const group of [
		{ label: "我的线索", items: ownClues },
		{ label: "公共线索", items: publicClues },
	]) {
		if (!group.items.length) continue;
		const h = document.createElement("li");
		h.className = "muted";
		h.style.fontSize = "12px";
		h.textContent = group.label;
		list.appendChild(h);
		for (const c of group.items) {
			const li = document.createElement("li");
			li.className = "clue-item";
			li.innerHTML = `<span>${esc(c.text)}</span>`;
			const btn = document.createElement("button");
			btn.className = "ghost";
			btn.textContent = "出示";
			btn.style.padding = "4px 8px";
			btn.style.fontSize = "12px";
			btn.onclick = () => doShow(c.id);
			li.appendChild(btn);
			list.appendChild(li);
		}
	}
}

function renderTurn() {
	if (snapshot.phase !== "discussion") {
		turnBanner.textContent = "";
		return;
	}
	const t = snapshot.currentTurn;
	if (!t) {
		turnBanner.textContent = "";
		return;
	}
	const name = roleName(t) ?? t;
	const mine = t === snapshot.humanRoleId;
	turnBanner.textContent = `轮到：${name}${mine ? "（你）" : ""}`;
	turnBanner.style.color = mine ? "var(--good)" : "var(--warn)";
}

function roleName(roleId) {
	if (!view) return null;
	return view.roles.find((r) => r.id === roleId)?.name ?? null;
}

function rebuildLogs() {
	chatLog.innerHTML = "";
	for (const e of snapshot.publicEvents) appendPublic(e);
	privateLog.innerHTML = "";
	for (const e of snapshot.privateEvents) appendPrivate(e);
	scrollBottom(chatLog);
	scrollBottom(privateLog);
}

function scrollBottom(el) {
	el.scrollTop = el.scrollHeight;
}

// ---------- 乐观更新（加载反馈） ----------

/** 尚未收到服务端确认的占位节点映射。键 = "类型:目标"，值 = DOM 节点 */
const pendingOptimistic = new Map();

function optimisticKey(type, target) {
	return `${type}:${target}`;
}

function insertOptimisticPrivate(key, html) {
	removeOptimistic(key);
	const node = document.createElement("div");
	node.className = "msg optimistic";
	node.dataset.tempId = key;
	node.innerHTML = html;
	privateLog.appendChild(node);
	pendingOptimistic.set(key, node);
	scrollBottom(privateLog);
}

function insertOptimisticPublic(key, html) {
	removeOptimistic(key);
	const node = document.createElement("div");
	node.className = "msg optimistic";
	node.dataset.tempId = key;
	node.innerHTML = html;
	chatLog.appendChild(node);
	pendingOptimistic.set(key, node);
	scrollBottom(chatLog);
}

function removeOptimistic(key) {
	const node = pendingOptimistic.get(key);
	if (node) {
		node.remove();
		pendingOptimistic.delete(key);
	}
}

/**
 * 用真实事件替换乐观占位节点。当 SSE 到达时调用：
 * 如果日志末尾是占位且与到达事件匹配 → 替换，否则返回 false（调用方需正常追加）。
 */
function tryReplaceOptimistic(ev, logEl) {
	const last = logEl.lastElementChild;
	if (!last || !last.classList.contains("optimistic")) return false;
	const tempKey = last.dataset.tempId;
	if (!tempKey) return false;
	// 解析占位键：investigate:角色id 或 whisper:角色id 或 endTurn:
	const parts = tempKey.split(":");
	const type = parts[0];
	const target = parts.slice(1).join(":");

	let match = false;
	if (type === "investigate" && ev.type === "investigate" && ev.target === target) {
		match = true;
	} else if (type === "whisper" && ev.type === "whisper" && ev.target === target) {
		match = true;
	} else if (type === "endTurn" && ev.type === "system" && /回合/.test(ev.text ?? "")) {
		match = true;
	}
	if (!match) return false;

	// 用真实内容替换占位
	last.className = `msg ${ev.type}`;
	last.removeAttribute("data-temp-id");
	last.innerHTML = renderMessageContent(ev);
	pendingOptimistic.delete(tempKey);
	scrollBottom(logEl);
	return true;
}

/** 根据事件类型生成消息 HTML（与 appendPublic / appendPrivate 的逻辑一致，但使用 markdown） */
function renderMessageContent(ev) {
	const who = esc(ev.roleName ?? (ev.type === "narrator" ? "主持人" : ""));
	switch (ev.type) {
		case "narrator":
			return `<span class="who">主持人</span>${renderMarkdown(ev.text ?? "")}`;
		case "speak":
			return `<span class="who">${who}</span>${renderMarkdown(ev.text ?? "")}`;
		case "show":
			return `<span class="who">${who}</span>出示线索：${renderMarkdown(ev.text ?? "")}`;
		case "vote":
			return `${who} 已投票`;
		case "turn":
			return `→ ${who}${ev.humanTurn ? "（你）" : ""}`;
		case "system":
		case "game_end":
			return renderMarkdown(ev.text ?? "");
		default:
			return renderMarkdown(ev.text ?? "");
	}
}

function renderPrivateMessageContent(ev) {
	const who = esc(ev.roleName ?? "");
	switch (ev.type) {
		case "whisper":
			return `<span class="who">${who}</span>（私聊）${renderMarkdown(ev.text ?? "")}`;
		case "investigate":
			return `<span class="who">调查</span>${esc(ev.targetName ?? "")}：${renderMarkdown(ev.text ?? "")}`;
		case "system":
			return renderMarkdown(ev.text ?? "");
		default:
			return renderMarkdown(ev.text ?? "");
	}
}

// ---------- Markdown 渲染 ----------

/**
 * 基础子集 Markdown 渲染器（与 esc 配合使用）。
 * 支持：粗体 **text**、斜体 *text*、引用 > text
 * 输出直接用于 innerHTML，所有非白名单标签均已 XSS 安全转义。
 */
function renderMarkdown(text) {
	let result = esc(text);
	// 粗体
	result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	// 斜体（粗体替换后，剩余单 * 即为斜体）
	result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
	// 引用行（> 开头）
	result = result.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
	return result;
}

// ----------追加消息（带 markdown） ----------

function appendPublic(e) {
	const node = document.createElement("div");
	const mine = e.roleId && e.roleId === snapshot.humanRoleId;
	const who = e.roleName ?? (e.type === "narrator" ? "主持人" : "");
	switch (e.type) {
		case "narrator":
			node.className = "msg narrator";
			node.innerHTML = `<span class="who">主持人</span>${renderMarkdown(e.text)}`;
			break;
		case "speak":
			node.className = "msg speak" + (mine ? " my" : "");
			node.innerHTML = `<span class="who">${esc(who)}</span>${renderMarkdown(e.text)}`;
			break;
		case "show":
			node.className = "msg show";
			node.innerHTML = `<span class="who">${esc(who)}</span>出示线索：${renderMarkdown(e.text)}`;
			break;
		case "whisper":
			break;
		case "vote":
			node.className = "msg vote";
			node.innerHTML = `${esc(who)} 已投票`;
			break;
		case "turn":
			node.className = "msg turn";
			node.innerHTML = `→ ${esc(who)}${e.humanTurn ? "（你）" : ""}`;
			break;
		case "system":
		case "game_end":
			node.className = "msg system";
			node.innerHTML = renderMarkdown(e.text ?? "");
			break;
		default:
			node.className = "msg system";
			node.innerHTML = renderMarkdown(e.text ?? "");
	}
	if (node.innerHTML) chatLog.appendChild(node);
	scrollBottom(chatLog);
}

function appendPrivate(e) {
	const node = document.createElement("div");
	const who = e.roleName ?? "";
	switch (e.type) {
		case "whisper":
			node.className = "msg whisper";
			node.innerHTML = `<span class="who">${esc(who)}</span>（私聊）${renderMarkdown(e.text)}`;
			break;
		case "investigate":
			node.className = "msg investigate";
			node.innerHTML = `<span class="who">调查</span>${esc(e.targetName ?? "")}：${renderMarkdown(e.text)}`;
			break;
		case "system":
			node.className = "msg system";
			node.innerHTML = renderMarkdown(e.text ?? "");
			break;
		default:
			node.className = "msg system";
			node.innerHTML = renderMarkdown(e.text ?? "");
	}
	if (node.innerHTML) privateLog.appendChild(node);
	scrollBottom(privateLog);
}

// ---------- 行动面板 ----------

function renderActions() {
	const body = $("action-body");
	const phase = snapshot.phase;
	if (phase === "reading") {
		body.innerHTML = `<p class="muted">阅读你的角色设定，准备开始。</p><button id="btn-start">开始游戏</button>`;
		$("btn-start").onclick = async () => {
			try {
				await guard(() => api(`/api/games/${gameId}/start`, { method: "POST" }));
			} catch (err) {
				alert(err.message);
			}
		};
		return;
	}
	if (phase === "discussion") {
		const mine = snapshot.currentTurn === snapshot.humanRoleId;
		if (!mine) {
			body.innerHTML = `<p class="muted">等待其他玩家行动…</p>`;
			return;
		}
		body.innerHTML = `
			<div class="act-row">
				<label>公开发言</label>
				<textarea id="in-speak" rows="3"></textarea>
				<div class="btn-row">
					<button class="ghost" id="btn-polish-speak" title="AI 润色发言">✨ 润色</button>
					<button id="btn-speak">发言</button>
				</div>
			</div>
			<div class="act-row">
				<label>私聊</label>
				<select id="whisper-target"></select>
				<input id="in-whisper" placeholder="私聊内容" />
				<div class="btn-row">
					<button class="ghost" id="btn-polish-whisper" title="AI 润色私聊内容">✨ 润色</button>
					<button id="btn-whisper">发送私聊</button>
				</div>
			</div>
			<div class="act-row">
				<label>调查（每回合限一次）</label>
				<div class="target-grid" id="invest-grid"></div>
			</div>
			<div class="btn-row">
				<button class="ghost" id="btn-end">结束回合</button>
			</div>
		`;
		// 私聊目标
		const targetSel = $("whisper-target");
		targetSel.innerHTML = "";
		for (const r of view.roles) {
			if (r.id === snapshot.humanRoleId) continue;
			const opt = document.createElement("option");
			opt.value = r.id;
			opt.textContent = r.name;
			targetSel.appendChild(opt);
		}
		$("btn-speak").onclick = () => doSpeak();
		$("btn-whisper").onclick = () => doWhisper();
		$("btn-end").onclick = () => doEndTurn();
		$("btn-polish-speak").onclick = () => doPolish("in-speak", "btn-polish-speak");
		$("btn-polish-whisper").onclick = () => doPolish("in-whisper", "btn-polish-whisper");
		// 调查目标
		const grid = $("invest-grid");
		grid.innerHTML = "";
		for (const r of view.roles) {
			if (r.id === snapshot.humanRoleId) continue;
			const b = document.createElement("button");
			b.textContent = r.name;
			b.onclick = () => doInvestigate(r.id);
			grid.appendChild(b);
		}
		for (const l of view.locations) {
			const b = document.createElement("button");
			b.textContent = l.name;
			b.onclick = () => doInvestigate(l.id);
			grid.appendChild(b);
		}
		return;
	}
	if (phase === "voting") {
		body.innerHTML = `
			<p class="muted">投出你认为的真凶（可弃权）。</p>
			<div class="target-grid" id="vote-grid"></div>
			<button class="ghost" id="btn-abstain">弃权</button>
		`;
		const grid = $("vote-grid");
		grid.innerHTML = "";
		for (const r of view.roles) {
			const b = document.createElement("button");
			b.textContent = r.name;
			b.onclick = () => doVote(r.id);
			grid.appendChild(b);
		}
		$("btn-abstain").onclick = () => doVote(null);
		return;
	}
	if (phase === "finished") {
		body.innerHTML = `<p class="muted">游戏已结束。</p>`;
	}
}

// ---------- 行动 ----------

function guard(fn) {
	if (busy) return Promise.resolve();
	busy = true;
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			busy = false;
		});
}

/** 设置/恢复按钮 loading 状态 */
function buttonLoading(btnId, loading) {
	const btn = $(btnId);
	if (!btn) return;
	btn.disabled = loading;
	btn.textContent = loading ? "处理中…" : btn.dataset.originalText ?? btn.textContent;
	if (loading) btn.dataset.originalText = btn.dataset.originalText ?? btn.textContent;
	else delete btn.dataset.originalText;
}

async function doSpeak() {
	const content = $("in-speak").value.trim();
	if (!content) return alert("请输入发言内容");
	try {
		await guard(() =>
			api(`/api/games/${gameId}/action`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "speak", content }),
			}),
		);
		$("in-speak").value = "";
	} catch (err) {
		alert(err.message);
	}
}

async function doWhisper() {
	const target = $("whisper-target").value;
	const content = $("in-whisper").value.trim();
	if (!content) return alert("请输入私聊内容");
	// 乐观更新：立即显示私聊消息（发送中 → 真实内容）
	const key = optimisticKey("whisper", target);
	insertOptimisticPrivate(
		key,
		`<span class="who">我</span>（私聊）<em>（发送中…）</em>`,
	);
	try {
		await guard(() =>
			api(`/api/games/${gameId}/action`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "whisper", target, content }),
			}),
		);
		$("in-whisper").value = "";
	} catch (err) {
		alert(err.message);
		removeOptimistic(key);
	}
}

async function doInvestigate(target) {
	const key = optimisticKey("investigate", target);
	const targetName = view.roles.find((r) => r.id === target)?.name ?? view.locations.find((l) => l.id === target)?.name ?? target;
	// 乐观占位
	insertOptimisticPrivate(key, `<span class="who">调查</span>${esc(targetName)}：<em>调查中…</em>`);
	try {
		await guard(() =>
			api(`/api/games/${gameId}/action`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "investigate", target }),
			}),
		);
	} catch (err) {
		alert(err.message);
		removeOptimistic(key);
	}
}

async function doShow(clueId) {
	try {
		await guard(() =>
			api(`/api/games/${gameId}/action`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "show", clueId }),
			}),
		);
	} catch (err) {
		alert(err.message);
	}
}

async function doEndTurn() {
	// 乐观更新：立即显示"结束回合中"系统消息
	insertOptimisticPublic("endTurn:", `<span class="who">系统</span><em>回合结束中…</em>`);
	try {
		await guard(() =>
			api(`/api/games/${gameId}/action`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "endTurn" }),
			}),
		);
	} catch (err) {
		alert(err.message);
		removeOptimistic("endTurn:");
	}
}

async function doVote(target) {
	try {
		await guard(() =>
			api(`/api/games/${gameId}/vote`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ target }),
			}),
		);
	} catch (err) {
		alert(err.message);
	}
}

// ---------- AI 润色 ----------

async function doPolish(textareaId, btnId) {
	const textarea = $(textareaId);
	const btn = $(btnId);
	if (!textarea || !textarea.value.trim()) return;
	const original = textarea.value;
	btn.disabled = true;
	btn.textContent = "润色中…";
	try {
		const res = await api(`/api/games/${gameId}/polish`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: original }),
		});
		if (res.polished) {
			textarea.value = res.polished;
		}
	} catch (err) {
		alert("润色失败：" + err.message);
	} finally {
		btn.disabled = false;
		btn.textContent = "✨ 润色";
	}
}

// ---------- 结果 ----------

function showResult() {
	const votes = snapshot.votes ?? {};
	const truth = snapshot.truth ?? null;
	const culpritName = truth ? roleName(truth.culprit) ?? truth.culprit : null;
	const rows = Object.entries(votes)
		.map(([rid, t]) => {
			const voter = roleName(rid) ?? rid;
			const tgt = t ? roleName(t) ?? t : "弃权";
			return `<div class="vote-line">${esc(voter)} → ${esc(tgt)}</div>`;
		})
		.join("");
	const won = snapshot.winner === "innocents" ? "好人阵营获胜 🎉" : "真凶逃脱 😈";
	$("result-body").innerHTML = `
		<h2>游戏结束</h2>
		<p>${won}</p>
		<h3>投票</h3>
		${rows}
		${truth ? `
			<div class="truth-box">
				<p><b>真凶：</b>${esc(culpritName ?? "")}</p>
				<p><b>动机：</b>${esc(truth.motive)}</p>
				<p><b>手法：</b>${esc(truth.method)}</p>
			</div>` : ""}
	`;
	resultDialog.showModal();
}

$("result-close").onclick = () => resultDialog.close();

// 对话框打开时锁定 body 滚动（iOS 兼容）
function lockScroll() {
	document.body.classList.add("dialog-open");
}
function unlockScroll() {
	document.body.classList.remove("dialog-open");
}
const _origShow = resultDialog.showModal;
resultDialog.showModal = function () {
	lockScroll();
	_origShow.call(this);
};
resultDialog.addEventListener("close", unlockScroll);

// ---------- 移动端 Tab 切换 ----------

function initMobileTabs() {
	const tabs = document.querySelectorAll("#mobile-tabs button");
	const chat = document.querySelector(".chat");
	const panels = document.querySelectorAll(".sidebar [data-tab]");

	tabs.forEach((btn) => {
		btn.addEventListener("click", () => {
			const target = btn.dataset.tabTarget;

			tabs.forEach((b) => b.classList.toggle("active", b === btn));

			if (target === "chat") {
				chat.classList.remove("tab-hidden");
				panels.forEach((p) => p.classList.remove("tab-active"));
				scrollBottom(chatLog);
			} else {
				chat.classList.add("tab-hidden");
				panels.forEach((p) => p.classList.toggle("tab-active", p.dataset.tab === target));
			}

			// 切换 tab 后回到顶部，避免上一 tab 的滚动位置残留
			window.scrollTo({ top: 0 });
		});
	});
}

initMobileTabs();

// ---------- Tour 游玩引导 ----------

const TOUR_STEPS = [
	{
		title: "🎭 欢迎加入剧本杀",
		text: "你将扮演一名角色，与其他玩家一起推理案情、找出真凶。下面带你快速了解游戏流程与各区域。",
		target: null,
		position: "center",
	},
	{
		title: "📋 这是你的角色",
		text: "右侧面板显示你的公开设定、只有你知道的私密信息、目标和手中线索。私密信息不要主动泄露哦。",
		target: "#role-panel",
		position: "left",
	},
	{
		title: "▶️ 开始游戏",
		text: "读完角色设定后，点击「开始游戏」进入讨论阶段。主持人将介绍案发背景与开场情境。",
		target: "#action-body",
		position: "left",
	},
	{
		title: "💬 讨论阶段",
		text: "左侧聊天区是公开讨论，所有玩家都能看到。多轮讨论，每人每回合依次发言、调查或私聊。",
		target: ".chat",
		position: "right",
	},
	{
		title: "⚔️ 行动面板",
		text: "轮到你时可：公开发言、私聊某人、调查角色/地点（每回合限1次）、出示线索、结束回合。也可以让 AI 帮你润色。",
		target: "#action-panel",
		position: "left",
	},
	{
		title: "🔍 私聊与调查结果",
		text: "这里显示你与他人的私聊记录以及你主动调查的发现，只有你自己能看到。",
		target: "[data-tab=\"private\"]",
		position: "left",
	},
	{
		title: "🗳️ 投票阶段",
		text: "讨论结束后进入投票，秘密投出你认为的真凶（也可弃权）。只有严格多数票投出真凶，好人阵营才能获胜。",
		target: "#action-body",
		position: "left",
	},
	{
		title: "🎉 揭晓真相",
		text: "主持人将完整揭晓真凶、动机、手法与时间线。游戏结束！你可以返回剧本库继续挑战。",
		target: "#phase-chip",
		position: "below",
	},
];

const TOUR_SEEN_KEY = "jubensha_tour_seen";

const Tour = {
	_active: false,
	_step: 0,

	init() {
		const seen = tryGetStorage(TOUR_SEEN_KEY);
		if (seen) {
			showReplayButton();
			return;
		}
		// 确保 snapshot 已加载（页面加载失败时不启动）
		if (!snapshot) {
			showReplayButton();
			return;
		}
		// 等用户先看到页面再弹出引导
		setTimeout(() => {
			if (!snapshot) return;
			Tour.start(0);
		}, 800);
	},

	start(stepIndex) {
		this._active = true;
		this._step = stepIndex;
		$("tour-dont-show").checked = false;
		const overlay = $("tour-overlay");
		overlay.classList.remove("hidden");
		this.render();
	},

	render() {
		const step = TOUR_STEPS[this._step];
		$("tour-title").textContent = step.title;
		$("tour-text").textContent = step.text;
		// dots
		const dotsEl = $("tour-dots");
		dotsEl.innerHTML = "";
		for (let i = 0; i < TOUR_STEPS.length; i++) {
			const d = document.createElement("span");
			d.className = "dot" + (i === this._step ? " active" : "");
			dotsEl.appendChild(d);
		}
		// 按钮可见性
		$("tour-prev").classList.toggle("hidden", this._step === 0);
		$("tour-next").textContent = this._step === TOUR_STEPS.length - 1 ? "完成" : "下一步";

		const highlight = $("tour-highlight");
		const tooltip = $("tour-tooltip");
		const isMobile = window.innerWidth <= 900;

		if (step.target && !isMobile) {
			const el = document.querySelector(step.target);
			if (el) {
				const r = el.getBoundingClientRect();
				highlight.style.left = (r.left - 4) + "px";
				highlight.style.top = (r.top - 4) + "px";
				highlight.style.width = (r.width + 8) + "px";
				highlight.style.height = (r.height + 8) + "px";
				highlight.classList.remove("hide");
				setTimeout(() => highlight.classList.add("visible"), 10);

				positionTooltip(tooltip, step.position, r);
			} else {
				highlight.classList.add("hide");
				highlight.classList.remove("visible");
				positionTooltip(tooltip, "below", { left: 20, top: 60, right: window.innerWidth - 20, bottom: 60, width: window.innerWidth - 40, height: 200 });
			}
		} else {
			highlight.classList.add("hide");
			highlight.classList.remove("visible");
			// 居中（欢迎步骤或移动端）
			const tw = 420;
			const th = 220;
			tooltip.style.left = ((window.innerWidth - tw) / 2) + "px";
			tooltip.style.top = ((window.innerHeight - th) / 2) + "px";
		}
	},

	next() {
		if (this._step < TOUR_STEPS.length - 1) {
			this._step++;
			this.render();
		} else {
			this.end();
		}
	},

	prev() {
		if (this._step > 0) {
			this._step--;
			this.render();
		}
	},

	end() {
		this._active = false;
		const overlay = $("tour-overlay");
		overlay.classList.add("hidden");
		// 任意关闭都标记为已见过，避免每次进入新房间都弹出
		trySetStorage(TOUR_SEEN_KEY, "1");
		showReplayButton();
	},
};

function positionTooltip(tooltip, position, targetRect) {
	const pad = 12;
	const gap = 16;
	// 先设置一个宽度以获取 tooltip 尺寸
	tooltip.style.left = "0px";
	tooltip.style.top = "0px";
	const tw = tooltip.offsetWidth;
	const th = tooltip.offsetHeight;
	const vw = window.innerWidth;
	const vh = window.innerHeight;

	let left, top;
	switch (position) {
		case "above":
			left = targetRect.left;
			top = targetRect.top - th - gap;
			break;
		case "below":
			left = targetRect.left;
			top = targetRect.bottom + gap;
			break;
		case "left":
			left = targetRect.left - tw - gap;
			top = targetRect.top;
			break;
		case "right":
			left = targetRect.right + gap;
			top = targetRect.top;
			break;
		case "center":
		default:
			left = (vw - tw) / 2;
			top = (vh - th) / 2;
			break;
	}

	// 边界检测
	if (left < pad) left = pad;
	if (left + tw > vw - pad) left = vw - tw - pad;
	if (top < pad) top = pad;
	if (top + th > vh - pad) top = vh - th - pad;

	tooltip.style.left = left + "px";
	tooltip.style.top = top + "px";
}

function trySetStorage(key, val) {
	try { localStorage.setItem(key, val); } catch { /* 隐私模式忽略 */ }
}
function tryGetStorage(key) {
	try { return localStorage.getItem(key); } catch { return null; }
}

function showReplayButton() {
	$("tour-replay").classList.remove("hidden");
}

// 按钮事件
$("tour-prev").onclick = (e) => { e.stopPropagation(); Tour.prev(); };
$("tour-next").onclick = (e) => { e.stopPropagation(); Tour.next(); };
$("tour-skip").onclick = (e) => { e.stopPropagation(); Tour.end(); };
$("tour-replay").onclick = () => {
	Tour.start(0);
};
// 点击遮罩背景关闭
$("tour-overlay").onclick = (e) => {
	if (e.target.id === "tour-overlay") Tour.end();
};
// Escape 关闭
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && Tour._active) Tour.end();
});

// 页面滚动/窗口尺寸变化时重新定位（仅当 Tour 活跃时）
window.addEventListener("resize", () => {
	if (Tour._active) Tour.render();
});
document.addEventListener("scroll", () => {
	if (Tour._active) Tour.render();
});

// 启动加载
load().then(() => Tour.init());
