import { openExternalHttps } from "./prHubPresentation";

export function prAuthorUrl(prUrl: string, login: string): string | null {
  try {
    const url = new URL(prUrl);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    // Resolve against the PR's host, including GitHub Enterprise installations.
    return `${url.origin}/${encodeURIComponent(login)}`;
  } catch {
    return null;
  }
}

export function PrAuthorLink({
  prUrl,
  login,
}: {
  prUrl: string;
  login: string | null | undefined;
}) {
  if (!login) return <>unknown</>;
  const href = prAuthorUrl(prUrl, login);
  if (!href) return <>{login}</>;
  return (
    <a
      href={href}
      className="font-medium hover:underline"
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void openExternalHttps(href, "author profile");
      }}
    >
      {login}
    </a>
  );
}
