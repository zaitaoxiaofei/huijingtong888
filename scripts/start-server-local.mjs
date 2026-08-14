import net from "node:net";

process.env.PORT ||= "8788";
process.env.APP_BASE_URL ||= `http://localhost:${process.env.PORT}`;

const port = Number(process.env.PORT);

async function isPortInUse(host) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(error.code)) {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

const occupied = await Promise.all([
  isPortInUse("127.0.0.1"),
  isPortInUse("::1"),
]);

if (occupied.some(Boolean)) {
  throw new Error(
    `Local server port ${port} is already in use; refusing to start a duplicate instance. Stop the existing ${port} process first.`,
  );
}

await import("../src/server.js");
