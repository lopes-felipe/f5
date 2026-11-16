import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { secureGithubPaths } from "./GithubCliProjection";
import { runWindowsPowerShell, WINDOWS_JSON_SERIALIZER } from "../windowsPowerShell";

it.skipIf(process.platform !== "win32")(
  "Windows projection ACLs grant only the current identity and disable inherited access",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "f5-private-acl-"));
    const file = path.join(directory, "credentials.json");
    await fs.writeFile(file, "synthetic fixture");
    try {
      await secureGithubPaths([
        { path: directory, directory: true },
        { path: file, directory: false },
      ]);
      const script =
        WINDOWS_JSON_SERIALIZER +
        "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
        `$paths = $json.DeserializeObject('${JSON.stringify([directory, file]).replaceAll("'", "''")}'); ` +
        "$results = [System.Collections.Generic.List[object]]::new(); foreach ($item in $paths) { " +
        "if ([System.IO.Directory]::Exists($item)) { $acl = [System.IO.Directory]::GetAccessControl($item) } else { $acl = [System.IO.File]::GetAccessControl($item) }; " +
        "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); " +
        "$results.Add(@{ protected = $acl.AreAccessRulesProtected; " +
        "ownerMatches = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Equals($sid); " +
        "ruleCount = $rules.Count; currentIdentityOnly = ($rules.Count -eq 1 -and $rules[0].IdentityReference.Equals($sid)); " +
        "fullControl = ($rules.Count -eq 1 -and $rules[0].AccessControlType -eq 'Allow' -and $rules[0].FileSystemRights -eq 'FullControl') }); }; " +
        "[Console]::Write($json.Serialize($results.ToArray()))";
      const { stdout } = await runWindowsPowerShell(script, { timeoutMs: 30_000 });
      expect(JSON.parse(stdout)).toEqual(
        [directory, file].map(() => ({
          protected: true,
          ownerMatches: true,
          ruleCount: 1,
          currentIdentityOnly: true,
          fullControl: true,
        })),
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
