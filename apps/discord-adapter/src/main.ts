import { env } from "@project-os/config";

// Long-running process holding an outbound Discord Gateway WebSocket (§8.5).
// Gateway connection, normalization, and the reply endpoint land in #16.
const coordinatorUrl = env("COORDINATOR_URL", "http://localhost:8080");
console.log(`discord-adapter started; forwarding to ${coordinatorUrl}`);
setInterval(() => {}, 1 << 30); // keep alive until the gateway exists
