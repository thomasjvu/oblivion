import { createApp } from "./api/app.js";
import { disablePlaintextLogs } from "./domain/integrations.js";

const port = Number(process.env.PORT ?? 8080);
const { server } = createApp();

server.listen(port, () => {
  if (!disablePlaintextLogs()) {
    console.log(`Oblivion listening on http://localhost:${port}`);
  }
});
