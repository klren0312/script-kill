/**
 * 跨域（CORS）统一配置：
 * - 未设置 CORS_ORIGINS：默认允许所有来源（本地开发/局域网联机场景）。
 * - CORS_ORIGINS=*：同上，显式全开。
 * - CORS_ORIGINS=https://a.com,https://b.com：只允许列出的来源（逗号分隔）。
 *
 * @fastify/cors 负责普通 HTTP 请求；SSE 走 reply.hijack() 绕过生命周期，
 * 需要在 writeHead 时手动附加同样的头，因此这里同时导出判定函数。
 */

function parseOrigins(): string[] | true {
	const raw = process.env.CORS_ORIGINS;
	if (!raw || raw.trim() === "*") return true;
	const origins = raw.split(",").map((s) => s.trim()).filter(Boolean);
	return origins.length > 0 ? origins : true;
}

/** 供 @fastify/cors 的 origin 选项使用。 */
export function corsOriginOption(): string[] | boolean {
	return parseOrigins();
}

/**
 * 判断请求来源是否被允许（origin 为空表示同源/非浏览器请求，直接放行）。
 */
export function isOriginAllowed(origin: string | undefined): boolean {
	if (!origin) return true;
	const allowed = parseOrigins();
	return allowed === true || allowed.includes(origin);
}

/**
 * 为手动写响应头的场景（如 SSE）生成 CORS 头。
 * 不允许的来源返回空对象，调用方应拒绝该请求。
 */
export function corsHeadersFor(origin: string | undefined): Record<string, string> {
	if (!origin || !isOriginAllowed(origin)) return {};
	return {
		"Access-Control-Allow-Origin": origin,
		Vary: "Origin",
		"Access-Control-Allow-Credentials": "true",
	};
}
