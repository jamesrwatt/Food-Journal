# Food Journal

A single-page recipe journal: To Make / Making / Made shelves, tagging, ratings on completion, and a photo prompt for finished dishes.

## Running it

This is a single self-contained HTML file — no build step, no server. Options:

- **Locally:** open `index.html` directly in a browser.
- **GitHub Pages:** once this repo is on GitHub, go to Settings → Pages, set the source to the `main` branch (root), and GitHub will publish it at `https://<your-username>.github.io/<repo-name>/`. That URL works from any device's browser, including tablets and phones — this is what unlocks camera capture for the "add a photo" flow.

## What's here vs. what isn't

All recipe data (shelf, tags, rating, photo) is stored in the browser's own `localStorage`. That means:

- Each device/browser that opens the page has its **own separate copy** of the data. Opening the same GitHub Pages link on two different phones does not sync between them.
- There's no login and no server — nothing here talks to a database.

Getting real shared state across family members (everyone sees the same shelves, same ratings, same photos) needs a small backend with a shared database — that's the next phase, not part of this static version. See `food-journal-roadmap.md` in the main Food Journal folder for that plan.

## Privacy note

GitHub Pages sites are **public by default** on free GitHub accounts — anyone with the URL can view them, and the URL can be discovered/indexed. If you'd rather this not be publicly reachable, consider:

- A private repo with GitHub Pages (requires GitHub Pro or a paid plan for private-repo Pages), or
- Hosting instead on a platform that supports access control, or
- Waiting for the real hosted-app phase, which can add a login.
