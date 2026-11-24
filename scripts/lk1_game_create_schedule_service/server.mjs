import { createGameCreateScheduleServer } from "../game-create-schedule-qa.mjs";

const server = createGameCreateScheduleServer();
server.headersTimeout = 5_000;
server.requestTimeout = 18_000;
server.maxRequestsPerSocket = 100;
server.listen(24811, "127.0.0.1", () => {
  process.stdout.write("LK1 schedule reader listening on loopback\n");
});
