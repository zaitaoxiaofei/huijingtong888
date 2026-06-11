process.env.PORT ||= "8788";
process.env.APP_BASE_URL ||= `http://localhost:${process.env.PORT}`;

await import("../src/server.js");
