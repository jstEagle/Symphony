#!/usr/bin/env node

import http from "node:http";

const args = process.argv.slice(2);
if (args[0] !== "serve") {
  process.stderr.write("expected serve command\n");
  process.exit(2);
}

const option = (name, fallback) => {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const hostname = option("--hostname", "0.0.0.0");
const requestedPort = Number(option("--port", "4096"));
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end("{}");
});

server.listen(requestedPort, hostname, () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");
  process.stdout.write(`opencode server listening on http://${hostname}:${address.port}\n`);
});
