import type { Plugin } from "vite";
import { assetHeaders } from "../../server/src/assetHttp";

/** Actual server policy tested in Chromium, without agent credentials or external traffic. */
export function assetSecurityFixture(): Plugin {
  let attempts = 0;
  return {
    name: "asset-security-fixture",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/__asset-security-count") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ attempts }));
          return;
        }
        if (url.pathname === "/__asset-security-probe") {
          attempts++;
          res.end("exfiltration attempted");
          return;
        }
        if (url.pathname !== "/api/workspace-assets/security-fixture/index.html") return next();
        attempts = 0;
        const origin = `http://${req.headers.host}`;
        res.writeHead(
          200,
          assetHeaders("index.html", `${origin}/api/workspace-assets/security-fixture/`),
        );
        res.end(`<!doctype html><title>Sandbox fixture</title>
          <script>
            fetch('/__asset-security-probe');
            navigator.sendBeacon('/__asset-security-probe','secret');
            window.open('/__asset-security-probe');
            parent.postMessage('unsafe-script-executed','*');
            document.querySelector('form').submit();
          </script>
          <script src="${origin}/__asset-security-probe"></script>
          <img src="${origin}/__asset-security-probe">
          <form action="${origin}/__asset-security-probe"><input name="secret" value="private"><button>Submit</button></form>
          <p>Passive document rendered</p>`);
      });
    },
  };
}
