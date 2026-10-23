import { createServer } from "node:http";

export const previewSnapshotSecrets = [
  "CHILD CREDENTIAL_β",
  "GRANDCHILD_CREDENTIAL_γ",
  "MASKED_CREDENTIAL_δ",
];

export async function createPreviewSnapshotFixture() {
  const secrets = previewSnapshotSecrets;
  let port;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    const url = new URL(request.url, "http://fixture.invalid");
    const foreign = url.searchParams.has("foreign") || url.pathname === "/other";
    const suffix = foreign ? "?foreign=1" : "";
    if (url.pathname === "/child") {
      response.end(`<input id="secret" type="password"><div contenteditable="true" style="-webkit-text-security:disc">${secrets[2]}</div><iframe src="http://127.0.0.1:${port}/grandchild${suffix}"></iframe><script>
        document.querySelector("input").value=${JSON.stringify(secrets[0])};
        Object.defineProperty(HTMLInputElement.prototype,"value",{get(){return "page-spoof";},set(){}});
      </script>`);
    } else if (url.pathname === "/grandchild") {
      response.end(`<div id="host"></div><script>
        const shadow=document.querySelector("#host").attachShadow({mode:"open"});
        shadow.innerHTML='<input type="password">';
        shadow.querySelector("input").value=${JSON.stringify(secrets[1])};
      </script>`);
    } else {
      response.end(
        `<title>${secrets[0]}</title><p>${"x".repeat(19_995)}${secrets[0]}</p><button id="${secrets[0]}">Action</button><iframe src="http://localhost:${port}/child${suffix}"></iframe>`,
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/`,
    foreignUrl: `http://127.0.0.1:${port}/other`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
