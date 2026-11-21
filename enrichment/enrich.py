#!/usr/bin/env python3
"""
Enrichit une liste d'abonnés (email + nom) avec des informations professionnelles
publiques, via l'API Firecrawl (recherche + scraping + extraction JSON) et
l'API publique Recherche d'entreprises (data.gouv.fr) pour l'année de création.

Usage :
    export FIRECRAWL_API_KEY=fc-...
    python enrich.py abonnes.csv -o abonnes_enrichis.csv
    python enrich.py abonnes.csv -o test.csv --limit 5      # tester sur 5 lignes

Le script est reprenable : chaque contact traité est mis en cache dans
.cache_enrichissement/ ; relancer la commande saute les contacts déjà faits.
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
from urllib.parse import urlparse

import requests

FIRECRAWL_BASE = os.environ.get("FIRECRAWL_BASE_URL", "https://api.firecrawl.dev/v2")
REGISTRE_URL = "https://recherche-entreprises.api.gouv.fr/search"

# --------------------------------------------------------------------------- #
# Référentiels
# --------------------------------------------------------------------------- #

# Webmails / FAI : le domaine de l'email ne dit rien sur l'activité.
FREE_MAIL_PREFIXES = {
    "gmail", "googlemail", "hotmail", "outlook", "live", "msn", "yahoo", "ymail",
    "icloud", "me", "mac", "aol", "gmx", "protonmail", "proton", "pm", "yandex",
    "mail", "zoho", "tutanota", "orange", "wanadoo", "free", "sfr", "neuf",
    "laposte", "bbox", "numericable", "club-internet", "aliceadsl", "voila",
    "hotmail-fr", "skynet", "bluewin", "videotron", "sympatico", "web", "libero",
}

SOCIAL_PATTERNS = {
    "linkedin": r"linkedin\.com/(in|company|school)/[^/?#\s]+",
    "instagram": r"instagram\.com/(?!p/|reel/|explore/|accounts/)[A-Za-z0-9_.]+",
    "facebook": r"facebook\.com/(?!sharer|share|dialog|plugins|tr\b)[^/?#\s]+",
    "youtube": r"youtube\.com/(@[^/?#\s]+|c/[^/?#\s]+|channel/[^/?#\s]+|user/[^/?#\s]+)",
    "tiktok": r"tiktok\.com/@[^/?#\s]+",
    "x_twitter": r"(?:twitter|x)\.com/(?!intent|share|home)[A-Za-z0-9_]{1,15}(?=[/?#\s]|$)",
    "pinterest": r"pinterest\.[a-z.]+/(?!pin/)[^/?#\s]+",
    "threads": r"threads\.(?:net|com)/@[^/?#\s]+",
    "malt": r"malt\.(?:fr|com)/profile/[^/?#\s]+",
}

NEWSLETTER_PATTERNS = {
    "Substack": r"[a-z0-9-]+\.substack\.com",
    "Beehiiv": r"beehiiv\.com|[a-z0-9-]+\.beehiiv\.com",
    "Kit/ConvertKit": r"convertkit\.com|kit\.com|ck\.page",
    "Mailchimp": r"mailchi\.mp|eepurl\.com|list-manage\.com",
    "Brevo/Sendinblue": r"sendinblue\.com|brevo\.com|sibforms\.com",
    "MailerLite": r"mailerlite\.com|mlsend\.com",
    "Systeme.io": r"systeme\.io",
    "Podcast": r"podcasts\.apple\.com|open\.spotify\.com/show|ausha\.co|anchor\.fm|podcast\.ausha",
}

# Sites à ne pas prendre comme « site professionnel » depuis la recherche.
NOT_A_BUSINESS_SITE = (
    "linkedin.", "facebook.", "instagram.", "twitter.", "x.com", "youtube.",
    "tiktok.", "pinterest.", "threads.", "pagesjaunes.", "societe.com",
    "pappers.", "infogreffe.", "verif.com", "manageo.", "wikipedia.",
    "annuaire-entreprises", "lefigaro.", "copainsdavant.", "leboncoin.",
    "indeed.", "welcometothejungle.", "glassdoor.",
)

EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "correspond_a_la_personne": {
            "type": "boolean",
            "description": "true si ce site est clairement l'activité professionnelle de la personne recherchée",
        },
        "nom_activite": {"type": "string", "description": "Nom commercial de l'activité / marque / cabinet"},
        "metier": {"type": "string", "description": "Métier principal (ex : naturopathe, architecte d'intérieur, consultante RH)"},
        "specialisation": {"type": "string", "description": "Spécialisation ou niche"},
        "annee_lancement": {"type": "integer", "description": "Année de création/lancement de l'activité si mentionnée"},
        "siren": {"type": "string", "description": "Numéro SIREN (9 chiffres) ou SIRET si présent (mentions légales)"},
        "type_clientele": {"type": "string", "description": "Clientèle visée : particuliers, entreprises, B2B/B2C, secteur..."},
        "offres": {"type": "array", "items": {"type": "string"}, "description": "Offres/services/produits proposés"},
        "a_une_newsletter": {"type": "boolean", "description": "Le site propose-t-il une inscription à une newsletter ?"},
        "medias": {
            "type": "array", "items": {"type": "string"},
            "description": "Médias produits par la personne : blog, podcast, chaîne YouTube, magazine, livre...",
        },
    },
}


def extraction_prompt(name: str) -> str:
    return (
        f"Cette page est candidate pour être le site professionnel de « {name} ». "
        "Extrais uniquement des informations présentes sur la page, sans inventer. "
        "Laisse un champ vide si l'information n'est pas présente. "
        "Indique correspond_a_la_personne = false si rien ne relie la page à cette personne."
    )


# --------------------------------------------------------------------------- #
# Client Firecrawl
# --------------------------------------------------------------------------- #

class OutOfCredits(Exception):
    pass


class Firecrawl:
    def __init__(self, api_key: str, base: str = FIRECRAWL_BASE, pause: float = 0.5):
        self.base = base.rstrip("/")
        self.pause = pause
        self.s = requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})

    def _post(self, path: str, body: dict, timeout: int = 90) -> dict:
        for attempt in range(5):
            r = self.s.post(f"{self.base}{path}", json=body, timeout=timeout)
            if r.status_code == 429:  # rate limit
                time.sleep(min(60, 5 * 2 ** attempt))
                continue
            if r.status_code == 402:
                raise OutOfCredits(r.text[:300])
            if r.status_code >= 500 and attempt < 2:
                time.sleep(3)
                continue
            if not r.ok:
                raise RuntimeError(f"Firecrawl {path} HTTP {r.status_code}: {r.text[:300]}")
            time.sleep(self.pause)
            return r.json()
        raise RuntimeError(f"Firecrawl {path}: trop de 429, abandon")

    def search(self, query: str, limit: int = 6, location: str | None = "France") -> list[dict]:
        body = {"query": query, "limit": limit}
        if location:
            body["location"] = location
        try:
            res = self._post("/search", body)
        except RuntimeError as e:
            if "HTTP 400" in str(e) and location:  # paramètre refusé -> requête minimale
                res = self._post("/search", {"query": query, "limit": limit})
            else:
                raise
        data = res.get("data", [])
        if isinstance(data, dict):  # v2 : {"web": [...], "news": [...]}
            data = data.get("web", [])
        return [d for d in data if isinstance(d, dict) and d.get("url")]

    def scrape_extract(self, url: str, name: str) -> dict:
        body = {
            "url": url,
            "formats": ["links", {"type": "json", "schema": EXTRACTION_SCHEMA, "prompt": extraction_prompt(name)}],
            "onlyMainContent": False,  # garder header/footer : c'est là que sont les liens sociaux
            "timeout": 60000,
        }
        res = self._post("/scrape", body)
        return res.get("data", {}) or {}


# --------------------------------------------------------------------------- #
# Registre des entreprises (gratuit, sans clé)
# --------------------------------------------------------------------------- #

def registre_lookup(siren: str | None, nom_activite: str | None, nom_personne: str) -> dict:
    q = None
    if siren:
        digits = re.sub(r"\D", "", siren)
        if len(digits) >= 9:
            q = digits[:9]
    if not q and nom_activite:
        q = nom_activite
    if not q:
        return {}
    try:
        r = requests.get(REGISTRE_URL, params={"q": q, "per_page": 3}, timeout=20)
        if not r.ok:
            return {}
        results = r.json().get("results", [])
    except (requests.RequestException, ValueError):
        return {}
    if not results:
        return {}
    best = results[0]
    # Sans SIREN, on n'accepte le résultat que si un dirigeant porte le nom de la personne.
    if not (siren and q.isdigit()):
        last = nom_personne.split()[-1].lower() if nom_personne.split() else ""
        dirigeants = json.dumps(best.get("dirigeants", []), ensure_ascii=False).lower()
        if not last or last not in dirigeants:
            return {}
    date = best.get("date_creation") or ""
    return {
        "siren": best.get("siren", ""),
        "nom_legal": best.get("nom_complet", ""),
        "date_creation": date,
        "annee": date[:4] if date else "",
        "code_naf": best.get("activite_principale", ""),
    }


# --------------------------------------------------------------------------- #
# Logique d'enrichissement
# --------------------------------------------------------------------------- #

def email_domain(email: str) -> str | None:
    if "@" not in email:
        return None
    dom = email.rsplit("@", 1)[1].strip().lower()
    prefix = dom.split(".")[0]
    if prefix in FREE_MAIL_PREFIXES:
        return None
    return dom


def host(url: str) -> str:
    return urlparse(url).netloc.lower().removeprefix("www.")


def find_socials(urls: list[str]) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for u in urls:
        for platform, pat in SOCIAL_PATTERNS.items():
            m = re.search(pat, u, re.I)
            if m:
                clean = "https://" + re.sub(r"^https?://(www\.)?", "", u.split("?")[0].rstrip("/"))
                found.setdefault(platform, [])
                if clean not in found[platform]:
                    found[platform].append(clean)
    return found


def find_newsletter_tools(urls: list[str]) -> list[str]:
    blob = "\n".join(urls)
    return [name for name, pat in NEWSLETTER_PATTERNS.items() if re.search(pat, blob, re.I)]


def name_tokens(name: str) -> list[str]:
    return [t.lower() for t in re.split(r"[\s\-']+", name) if len(t) >= 3]


def rank_candidates(results: list[dict], name: str) -> list[str]:
    toks = name_tokens(name)
    scored = []
    for i, r in enumerate(results):
        url = r["url"]
        if any(bad in host(url) for bad in NOT_A_BUSINESS_SITE):
            continue
        text = f"{url} {r.get('title', '')} {r.get('description', '')}".lower()
        score = sum(t in text for t in toks) * 10 - i
        scored.append((score, url))
    scored.sort(reverse=True)
    return [u for s, u in scored]


def enrich_contact(fc: Firecrawl, email: str, name: str, max_scrapes: int = 2) -> dict:
    sources: list[str] = []
    search_links: list[str] = []
    candidates: list[str] = []

    dom = email_domain(email)
    if dom:
        candidates.append(f"https://{dom}")

    if name or not candidates:
        query = f"\"{name}\"" if name else email
        if dom:
            query += f" {dom}"
        results = fc.search(query)
        search_links = [r["url"] for r in results]
        for u in rank_candidates(results, name):
            if host(u) not in {host(c) for c in candidates}:
                candidates.append(u)

    extracted: dict = {}
    page_links: list[str] = []
    site = ""
    for url in candidates[:max_scrapes]:
        try:
            data = fc.scrape_extract(url, name or email)
        except OutOfCredits:
            raise
        except Exception as e:  # site down, timeout, etc.
            sources.append(f"échec {url}: {str(e)[:80]}")
            continue
        j = data.get("json") or {}
        from_email_domain = dom and host(url) == host(f"https://{dom}")
        if j.get("correspond_a_la_personne") or from_email_domain:
            extracted, page_links = j, data.get("links") or []
            site = (data.get("metadata") or {}).get("sourceURL") or url
            sources.append(site)
            break

    all_links = page_links + search_links
    socials = find_socials(all_links)
    tools = find_newsletter_tools(all_links)
    reg = registre_lookup(extracted.get("siren"), extracted.get("nom_activite"), name) if extracted else {}
    if reg:
        sources.append(f"registre:{reg['siren']}")

    annee = extracted.get("annee_lancement") or ""
    source_annee = "site" if annee else ""
    if reg.get("annee"):
        if not annee:
            annee, source_annee = reg["annee"], "registre"
        elif str(annee) != reg["annee"]:
            source_annee = f"site (registre : {reg['annee']})"

    medias = list(extracted.get("medias") or [])
    newsletter = bool(extracted.get("a_une_newsletter")) or any(t != "Podcast" for t in tools)
    if "Podcast" in tools and not any("podcast" in m.lower() for m in medias):
        medias.append("Podcast")
    if "youtube" in socials and not any("youtube" in m.lower() for m in medias):
        medias.append("Chaîne YouTube")

    if not site:
        confiance = "faible" if socials else "aucune"
    elif dom:
        confiance = "haute"
    else:
        confiance = "moyenne"

    return {
        "nom_activite": extracted.get("nom_activite") or reg.get("nom_legal", ""),
        "site_professionnel": site,
        "metier": extracted.get("metier", ""),
        "specialisation": extracted.get("specialisation", ""),
        "annee_lancement": annee,
        "source_annee": source_annee,
        "siren": reg.get("siren") or extracted.get("siren", ""),
        "type_clientele": extracted.get("type_clientele", ""),
        "offres": " | ".join(extracted.get("offres") or []),
        "newsletter": "oui" if newsletter else ("non" if site else ""),
        "outils_newsletter": ", ".join(t for t in tools if t != "Podcast"),
        "medias": ", ".join(medias),
        "reseaux_presents": ", ".join(sorted(socials)),
        **{f"lien_{p}": " ; ".join(v) for p, v in socials.items()},
        "confiance": confiance,
        "sources": " ; ".join(sources),
    }


# --------------------------------------------------------------------------- #
# CSV
# --------------------------------------------------------------------------- #

def read_csv(path: str) -> tuple[list[dict], list[str]]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        sample = f.read(4096)
        f.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(f, dialect=dialect)
        return list(reader), reader.fieldnames or []


def detect_columns(fields: list[str], email_col: str | None, name_col: str | None):
    low = {f.lower().strip(): f for f in fields}
    if not email_col:
        email_col = next((f for k, f in low.items() if "mail" in k), None)
    first = last = None
    if not name_col:
        first = next((f for k, f in low.items() if k in {"prénom", "prenom", "first name", "firstname", "first_name"}), None)
        last = next((f for k, f in low.items() if k in {"nom", "last name", "lastname", "last_name", "nom de famille"}), None)
        if not (first and last):
            name_col = next((f for k, f in low.items()
                             if k in {"nom", "name", "nom complet", "full name", "fullname", "nom et prénom"}), None)
            first = last = None
    if not email_col:
        sys.exit(f"Colonne email introuvable parmi {fields} : utilisez --email-col")
    return email_col, name_col, first, last


ALL_SOCIAL_COLS = [f"lien_{p}" for p in SOCIAL_PATTERNS]
OUT_COLS = [
    "nom_activite", "site_professionnel", "metier", "specialisation", "annee_lancement", "source_annee",
    "siren", "type_clientele", "offres", "newsletter", "outils_newsletter", "medias", "reseaux_presents",
    *ALL_SOCIAL_COLS, "confiance", "sources", "erreur",
]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("-o", "--output", default="abonnes_enrichis.csv")
    ap.add_argument("--email-col")
    ap.add_argument("--name-col")
    ap.add_argument("--limit", type=int, help="traiter seulement les N premières lignes")
    ap.add_argument("--max-scrapes", type=int, default=2, help="pages scrapées max par contact (crédits)")
    ap.add_argument("--cache-dir", default=".cache_enrichissement")
    args = ap.parse_args()

    key = os.environ.get("FIRECRAWL_API_KEY")
    if not key:
        sys.exit("Définissez FIRECRAWL_API_KEY (clé fc-... depuis firecrawl.dev)")

    rows, fields = read_csv(args.input)
    email_col, name_col, first_col, last_col = detect_columns(fields, args.email_col, args.name_col)
    if args.limit:
        rows = rows[: args.limit]
    os.makedirs(args.cache_dir, exist_ok=True)
    fc = Firecrawl(key)

    out_rows = []
    for i, row in enumerate(rows, 1):
        email = (row.get(email_col) or "").strip()
        if name_col:
            name = (row.get(name_col) or "").strip()
        elif first_col:
            name = f"{row.get(first_col, '').strip()} {row.get(last_col, '').strip()}".strip()
        else:
            name = ""
        cache_file = os.path.join(args.cache_dir, hashlib.sha1(email.lower().encode()).hexdigest() + ".json")

        if os.path.exists(cache_file):
            with open(cache_file, encoding="utf-8") as f:
                info = json.load(f)
            status = "cache"
        elif not email:
            info, status = {"erreur": "email vide"}, "ignoré"
        else:
            try:
                info = enrich_contact(fc, email, name, args.max_scrapes)
                status = info["confiance"]
            except OutOfCredits as e:
                print(f"\nCrédits Firecrawl épuisés ({e}). Résultats partiels écrits ; relancez après recharge.")
                break
            except Exception as e:
                info, status = {"erreur": str(e)[:200]}, "erreur"
            if "erreur" not in info:
                with open(cache_file, "w", encoding="utf-8") as f:
                    json.dump(info, f, ensure_ascii=False)
        print(f"[{i}/{len(rows)}] {email:<40} {status}")
        out_rows.append({**row, **{c: info.get(c, "") for c in OUT_COLS}})

    with open(args.output, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(fields) + [c for c in OUT_COLS if c not in fields], delimiter=";")
        w.writeheader()
        w.writerows(out_rows)
    print(f"\n{len(out_rows)} lignes écrites dans {args.output}")


if __name__ == "__main__":
    main()
