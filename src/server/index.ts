import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { publicDir } from "../paths.js";
import { routes } from "./routes.js";
import type { GameDeps } from "./games.js";

export async function buildServer(deps: GameDeps) {
	const app = Fastify({ logger: true, bodyLimit: 4 * 1024 * 1024 });

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
