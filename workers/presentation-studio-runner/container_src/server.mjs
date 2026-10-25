import http from "node:http";

const port = Number.parseInt(process.env.PORT || "8080", 10);
const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", renderer: "dashi", version: "0.4.11" }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "container_endpoint_not_found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`presentation-studio-container listening on ${port}`);
});
