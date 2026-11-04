import { envNumber } from "@project-os/config";
import { createApp } from "./app.ts";

// Local target: Bun + infra-local. Provider Layer wiring and the setInterval sweep land in #10/#15.
const port = envNumber("PORT", 8080);
createApp().listen(port);
console.log(`coordinator listening on :${port}`);
