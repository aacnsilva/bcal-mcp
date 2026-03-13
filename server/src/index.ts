import { createBcalServer } from "./runtime.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function startServer() {
  const server = createBcalServer({
    defaultWorkspacePath: process.env.BC_WORKSPACE_PATH ?? process.cwd(),
    sendNotification(method, params) {
      writeMessage({
        jsonrpc: "2.0",
        method,
        params,
      });
    },
  });

  let buffer = Buffer.alloc(0);

  process.stdin.on("data", async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        break;
      }

      const headerText = decoder.decode(buffer.subarray(0, headerEnd));
      const contentLengthLine = headerText
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("content-length:"));

      if (!contentLengthLine) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = Number(contentLengthLine.split(":")[1]?.trim() ?? "0");
      const totalLength = headerEnd + 4 + contentLength;
      if (buffer.length < totalLength) {
        break;
      }

      const payload = decoder.decode(buffer.subarray(headerEnd + 4, totalLength));
      buffer = buffer.subarray(totalLength);

      let request;
      try {
        request = JSON.parse(payload);
      } catch {
        continue;
      }

      const response = await server.handleRequest(request);
      if (response) {
        writeMessage(response);
      }
    }
  });

  process.stdin.resume();
}

function writeMessage(message: unknown) {
  const payload = encoder.encode(JSON.stringify(message));
  process.stdout.write(`Content-Length: ${payload.byteLength}\r\n\r\n`);
  process.stdout.write(payload);
}

if (import.meta.main) {
  startServer();
}
