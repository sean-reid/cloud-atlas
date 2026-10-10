import type { ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";

const NAV: [string, string][] = [
  ["/", "Overview"],
  ["/sites", "Sites"],
  ["/availability", "Availability"],
  ["/methodology", "Methodology"],
  ["/sources", "Sources"],
  ["/api", "API"],
];

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const search = useSearch();
  const demo = new URLSearchParams(search).get("demo") === "1";
  const keep = (path: string) => (search ? `${path}?${search}` : path);
  return (
    <>
      <a className="sr-only" href="#main">
        Skip to content
      </a>
      {demo && (
        <div className="banner" role="status">
          <div className="wrap">
            Demo mode: this view reads a labelled synthetic dataset, not live evidence. Remove
            demo=1 from the address to return.
          </div>
        </div>
      )}
      <header className="site">
        <div className="wrap">
          <Link href={keep("/")} className="wordmark">
            Cloud Atlas <small>global datacenter capacity observatory</small>
          </Link>
          <nav className="primary" aria-label="Primary">
            {NAV.map(([href, label]) => (
              <Link
                key={href}
                href={keep(href)}
                className={
                  location === href || (href !== "/" && location.startsWith(href)) ? "active" : ""
                }
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main id="main" className="wrap">
        {children}
      </main>
      <footer className="site">
        <div className="wrap">
          <a href="https://github.com/sean-reid/cloud-atlas">Source</a>
          <a href="https://epoch.ai/data/ai-data-centers">Epoch AI, AI data centers (CC BY 4.0)</a>
          <span>Tracked capacity from cited evidence, not a global total.</span>
        </div>
      </footer>
    </>
  );
}
