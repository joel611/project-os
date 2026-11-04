import { env } from "@project-os/config";

// Stub for the POC (§2.1). Inbound email normalization comes later.
const coordinatorUrl = env("COORDINATOR_URL", "http://localhost:8080");
console.log(`email-adapter stub started; forwarding to ${coordinatorUrl}`);
setInterval(() => {}, 1 << 30);
