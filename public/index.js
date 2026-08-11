const listEl = document.getElementById("script-list");
const emptyEl = document.getElementById("script-empty");
const dialog = document.getElementById("role-dialog");

const esc = (s) =>
	String(s ?? "").replace(/[&<>"']/g, (c) =>
		({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);

async function loadScripts() {
	const res = await fetch("/api/scripts");
	const cards = await res.json();
	emptyEl.classList.toggle("hidden", cards.length > 0);
	listEl.innerHTML = "";
	for (const c of cards) {
		const card = document.createElement("div");
		card.className = "script-card";
		card.innerHTML = `
			<h3>${esc(c.title)}</h3>
			<div class="meta">
				<span>${esc(c.genre)}</span>
				<span>${c.playerCount} 人</span>
				<span>${esc(c.difficulty)}</span>
				<span>约 ${c.estimatedMinutes} 分钟</span>
			</div>
			<p>${esc(c.description)}</p>
		`;
		card.onclick = () => openRoleSelect(c.id, c.title);
		listEl.appendChild(card);
	}
}

async function openRoleSelect(id, title) {
	document.getElementById("role-dialog-title").textContent = `选择角色 · ${title}`;
	const body = document.getElementById("role-dialog-body");
	body.innerHTML = '<p class="muted">加载中…</p>';
	dialog.showModal();
	const res = await fetch(`/api/scripts/${encodeURIComponent(id)}`);
	const view = await res.json();
	body.innerHTML = "";
	for (const r of view.roles) {
		const opt = document.createElement("div");
		opt.className = "role-option";
		opt.innerHTML = `
			<div class="left">
				<div class="name">${esc(r.name)}</div>
				<div class="desc">${esc(r.public)}</div>
				<div class="goal">目标：${esc(r.goal)}</div>
			</div>
			<button>选这个</button>
		`;
		opt.querySelector("button").onclick = async (e) => {
			e.stopPropagation();
			const btn = opt.querySelector("button");
			btn.disabled = true;
			btn.textContent = "加入中…";
			const res = await fetch("/api/games", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ scriptId: id, humanRoleId: r.id }),
			});
			const j = await res.json().catch(() => ({}));
			if (!res.ok) {
				alert(j.error ?? "创建失败");
				btn.disabled = false;
				btn.textContent = "选这个";
				return;
			}
			location.href = `/room.html?game=${encodeURIComponent(j.gameId)}`;
		};
		body.appendChild(opt);
	}
}

const genForm = document.getElementById("gen-form");
genForm.onsubmit = async (e) => {
	e.preventDefault();
	const btn = document.getElementById("gen-submit");
	const status = document.getElementById("gen-status");
	btn.disabled = true;
	btn.textContent = "生成中…";
	status.textContent = "正在调用模型生成剧本，可能需要一两分钟…";
	const body = {
		topic: document.getElementById("gen-topic").value,
		playerCount: Number(document.getElementById("gen-count").value),
		genre: document.getElementById("gen-genre").value || undefined,
		difficulty: document.getElementById("gen-difficulty").value || undefined,
	};
	try {
		const res = await fetch("/api/scripts/generate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const j = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(j.error ?? "生成失败");
		status.textContent = `已生成《${j.card.title}》，请选择角色：`;
		await loadScripts();
		await openRoleSelect(j.card.id, j.card.title);
	} catch (err) {
		status.textContent = "失败：" + err.message;
	}
	btn.disabled = false;
	btn.textContent = "开始生成";
};

document.getElementById("role-dialog-close").onclick = () => dialog.close();
dialog.addEventListener("click", (e) => {
	if (e.target === dialog) dialog.close();
});

loadScripts();
