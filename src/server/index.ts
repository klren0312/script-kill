import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { publicDir } from "../paths.js";
import { corsOriginOption } from "./cors.js";
import { routes } from "./routes.js";
import type { GameDeps } from "./games.js";

export async function buildServer(deps: GameDeps) {
	const app = Fastify({ logger: true, bodyLimit: 4 * 1024 * 1024 });

	// 跨域处理：需在路由注册前加载，预检（OPTIONS）与正式请求都会带上 CORS 响应头。
	await app.register(fastifyCors, {
		origin: corsOriginOption(),
		methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		credentials: true,
	});

	await app.register(fastifyWebsocket);

	await app.register(routes, { deps });

	await app.register(fastifyStatic, {
		root: publicDir,
		prefix: "/",
		wildcard: false,
	});

	// 兜底：/ 与其它未匹配 GET 都回到 index.html
	app.setNotFoundHandler((req, reply) => {
		if (req.method !== "GET" && req.method !== "HEAD") {
			reply.code(404).send({ error: "not found" });
			return;
		}
		reply.sendFile("index.html");
	});

	return app;
}
