# Fireside — site

Static single-page site for Fireside. Plain HTML/CSS/JS, no framework, no build step. This folder is the GitHub Pages deploy root, served at <https://latent-spaces.github.io/fireside/>.

The page uses the same screenshots as the repo README (`screenshots/`), so updating one updates both. `assets/` holds the logo and the social preview image (`og.png`, 1200×630).

## Local preview

```bash
python3 -m http.server 8000 -d docs
open http://localhost:8000
```

## Deploy (GitHub Pages)

In the repo's **Settings → Pages**, set the source to **Deploy from a branch**, branch `main`, folder **`/docs`**.
