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

function appendPublic(e) {
	const node = document.createElement("div");
	const mine = e.roleId && e.roleId === snapshot.humanRoleId;
	const who = e.roleName ?? (e.type === "narrator" ? "主持人" : "");
	switch (e.type) {
		case "narrator":
			node.className = "msg narrator";
			node.innerHTML = `<span class="who">主持人</span>${esc(e.text)}`;
			break;
		case "speak":
			node.className = "msg speak" + (mine ? " my" : "");
			node.innerHTML = `<span class="who">${esc(who)}</span>${esc(e.text)}`;
			break;
		case "show":
			node.className = "msg show";
			node.innerHTML = `<span class="who">${esc(who)}</span>出示线索：${esc(e.text)}`;
			break;
		case "whisper":
			// 公开流里不会出现
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
			node.className = "msg system";
			node.innerHTML = esc(e.text);
			break;
		case "game_end":
			node.className = "msg system";
			node.innerHTML = esc(e.text);
			break;
		default:
			node.className = "msg system";
			node.innerHTML = esc(e.text ?? "");
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
			node.innerHTML = `<span class="who">${esc(who)}</span>（私聊）${esc(e.text)}`;
			break;
		case "investigate":
			node.className = "msg investigate";
			node.innerHTML = `<span class="who">调查</span>${esc(e.targetName ?? "")}：${esc(e.text)}`;
			break;
		case "system":
			node.className = "msg system";
			node.innerHTML = esc(e.text);
			break;
		default:
			node.className = "msg system";
			node.innerHTML = esc(e.text ?? "");
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
				<button id="btn-speak">发言</button>
			</div>
			<div class="act-row">
				<label>私聊</label>
				<select id="whisper-target"></select>
				<input id="in-whisper" placeholder="私聊内容" />
				<button id="btn-whisper">发送私聊</button>
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
	}
}

async function doInvestigate(target) {
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
load();
