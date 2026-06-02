import { createApp } from "./api/app.js";

const port = Number(process.env.PORT ?? 8080);
const { server } = createApp();

server.listen(port, () => {
  if (process.env.OBLIVION_DISABLE_PLAINTEXT_LOGS !== "true") {
    console.log(`Oblivion listening on http://localhost:${port}`);
  }
});
