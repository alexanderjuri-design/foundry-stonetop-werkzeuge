"""Release-Werkzeug: py tools/release.py check | release vX.Y.Z | drop-release vX.Y.Z
Legt das öffentliche Repo an, pusht und erstellt ein Release mit module.json + module.zip.
Token kommt aus dem Git Credential Manager und wird nie ausgegeben."""
import subprocess, sys, json, os, zipfile, io
import requests

OWNER = "alexanderjuri-design"
REPO = "foundry-stonetop-werkzeuge"
SRC = r"D:\Code\foundry-stonetop-werkzeuge"
STEP = sys.argv[1]


def token():
    out = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
                         capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1]
    raise SystemExit("kein Token im Credential Manager")


T = token()
H = {"Authorization": "token " + T, "Accept": "application/vnd.github+json"}


def api(method, url, headers=None, **kw):
    r = requests.request(method, url if url.startswith("http") else "https://api.github.com" + url, headers=headers or H, timeout=60, **kw)
    if r.status_code >= 400:
        raise SystemExit(f"HTTP {r.status_code} {url}: {r.text[:300]}")
    return r


if STEP == "check":
    r = api("GET", "/user")
    print("login:", r.json()["login"], "| scopes:", r.headers.get("X-OAuth-Scopes"))
    ex = requests.get(f"https://api.github.com/repos/{OWNER}/{REPO}", headers=H, timeout=30)
    print("repo existiert schon:", ex.status_code == 200)

elif STEP == "create":
    r = api("POST", "/user/repos", json={"name": REPO, "private": False, "description":
            "Foundry-VTT-Modul für Stonetop (pbta): Ausrüstungs-Insert, speicherbare Kästchen in Moves, dauerhafte Journal-Checkboxen.",
            "has_wiki": False, "has_projects": False})
    print("angelegt:", r.json()["html_url"])

elif STEP == "drop-release":
    tag = sys.argv[2]
    r = requests.get(f"https://api.github.com/repos/{OWNER}/{REPO}/releases/tags/{tag}", headers=H, timeout=30)
    if r.status_code == 200:
        api("DELETE", f"/repos/{OWNER}/{REPO}/releases/{r.json()['id']}")
        print("release geloescht:", tag)
    r = requests.delete(f"https://api.github.com/repos/{OWNER}/{REPO}/git/refs/tags/{tag}", headers=H, timeout=30)
    print("tag geloescht:", tag, r.status_code)

elif STEP == "release":
    tag = sys.argv[2]
    rel = api("POST", f"/repos/{OWNER}/{REPO}/releases", json={"tag_name": tag, "name": tag, "body": f"Stonetop Werkzeuge {tag}"}).json()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(SRC):
            if ".git" in root.split(os.sep):
                continue
            for f in files:
                p = os.path.join(root, f)
                arc = os.path.relpath(p, SRC).replace(os.sep, "/")
                if arc.startswith((".git", "tools/")) or arc == "README.md":
                    continue
                z.write(p, arc)
    upload = rel["upload_url"].split("{")[0]
    for name, data, ctype in [("module.zip", buf.getvalue(), "application/zip"),
                              ("module.json", open(os.path.join(SRC, "module.json"), "rb").read(), "application/json")]:
        api("POST", f"{upload}?name={name}", data=data, headers={**H, "Content-Type": ctype})
        print("hochgeladen:", name, len(data), "Bytes")
    print("release:", rel["html_url"])
