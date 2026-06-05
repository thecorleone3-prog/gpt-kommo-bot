#!/usr/bin/env python3
"""
Exporta leads de Kommo cuyo nombre termina en "dota" a CSV.

Variables en .env (raíz del proyecto o carpeta scripts):
  KOMMO_SUBDOMAIN=tu-subdominio
  KOMMO_LONG_TOKEN=token_larga_duracion

Uso:
  pip install -r scripts/requirements-export.txt
  python scripts/export_leads_dota.py
  python scripts/export_leads_dota.py --output mis_leads.csv
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from requests.exceptions import ChunkedEncodingError, ConnectionError, Timeout

LEADS_PAGE_LIMIT = 250
CONTACTS_BATCH_SIZE = 50
REQUEST_DELAY_SEC = 0.6
MAX_RETRIES = 6
SUFFIX = "dota"


def load_env() -> tuple[str, str]:
    root = Path(__file__).resolve().parent.parent
    load_dotenv(root / ".env")
    load_dotenv(Path(__file__).resolve().parent / ".env")

    subdomain = os.getenv("KOMMO_SUBDOMAIN", "").strip()
    token = os.getenv("KOMMO_LONG_TOKEN", "").strip()

    if not subdomain or not token:
        print(
            "Faltan variables en .env:\n"
            "  KOMMO_SUBDOMAIN=tu-subdominio\n"
            "  KOMMO_LONG_TOKEN=eyJ...",
            file=sys.stderr,
        )
        sys.exit(1)

    return subdomain, token


def normalizar_telefono(valor: str | None) -> str | None:
    if not valor:
        return None
    digits = re.sub(r"\D", "", valor)
    return digits or None


def nombre_termina_en_dota(nombre: str | None) -> bool:
    if not nombre:
        return False
    return nombre.lower().endswith(SUFFIX)


def obtener_telefono_oficina(contacto: dict) -> str | None:
    fields = contacto.get("custom_fields_values") or []
    for field in fields:
        if field.get("field_code") != "PHONE":
            continue
        values = field.get("values") or []
        if not values:
            continue

        work = next(
            (v.get("value") for v in values if v.get("enum_code") == "WORK" and v.get("value")),
            None,
        )
        if work:
            return work.strip()

        first = values[0].get("value")
        return first.strip() if first else None

    return None


class KommoClient:
    def __init__(self, subdomain: str, token: str) -> None:
        self.base_url = f"https://{subdomain}.kommo.com"
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            }
        )

    def _get(self, path: str, params: list | dict | None = None) -> dict:
        url = f"{self.base_url}{path}"
        ultimo_error: Exception | None = None

        for intento in range(MAX_RETRIES):
            try:
                response = self.session.get(url, params=params, timeout=90)

                if response.status_code == 429:
                    espera = min(30, 2 ** intento + 1)
                    print(f"Rate limit, esperando {espera}s...")
                    time.sleep(espera)
                    continue

                if response.status_code >= 500:
                    espera = min(30, 2 ** intento + 1)
                    print(f"Error servidor {response.status_code}, reintento en {espera}s...")
                    time.sleep(espera)
                    continue

                response.raise_for_status()
                return response.json()

            except (ConnectionError, Timeout, ChunkedEncodingError) as err:
                ultimo_error = err
                espera = min(30, 2 ** intento + 1)
                print(f"Conexión interrumpida ({intento + 1}/{MAX_RETRIES}), esperando {espera}s...")
                time.sleep(espera)

        if ultimo_error:
            raise ultimo_error
        raise RuntimeError("No se pudo completar la petición a Kommo")

    def iter_leads(self):
        page = 1
        while True:
            data = self._get(
                "/api/v4/leads",
                params={"limit": LEADS_PAGE_LIMIT, "page": page, "with": "contacts"},
            )
            leads = (data.get("_embedded") or {}).get("leads") or []
            if not leads:
                break

            yield from leads

            page_info = data.get("_page")
            if isinstance(page_info, dict):
                total_pages = page_info.get("total_pages")
                if total_pages is not None and page >= total_pages:
                    break

            links = data.get("_links") or {}
            tiene_siguiente = bool(links.get("next"))

            if not tiene_siguiente and len(leads) < LEADS_PAGE_LIMIT:
                break

            page += 1
            time.sleep(REQUEST_DELAY_SEC)

    def fetch_contactos_batch(self, ids: list[int]) -> dict[int, dict]:
        """Obtiene varios contactos en una sola petición (menos carga que 1 por 1)."""
        if not ids:
            return {}

        params: list[tuple[str, int]] = [("limit", 250)]
        for cid in ids:
            params.append(("filter[id][]", cid))

        data = self._get("/api/v4/contacts", params=params)
        contactos = (data.get("_embedded") or {}).get("contacts") or []
        return {int(c["id"]): c for c in contactos if c.get("id")}


def cargar_contactos_por_lotes(
    client: KommoClient, ids_pendientes: set[int]
) -> dict[int, dict]:
    cache: dict[int, dict] = {}
    ids_lista = sorted(ids_pendientes)
    total_lotes = (len(ids_lista) + CONTACTS_BATCH_SIZE - 1) // CONTACTS_BATCH_SIZE

    print(f"Descargando {len(ids_lista)} contactos en {total_lotes} lote(s)...")

    for i in range(0, len(ids_lista), CONTACTS_BATCH_SIZE):
        lote = ids_lista[i : i + CONTACTS_BATCH_SIZE]
        lote_num = (i // CONTACTS_BATCH_SIZE) + 1

        try:
            batch = client.fetch_contactos_batch(lote)
            cache.update(batch)
            faltantes = [cid for cid in lote if cid not in batch]
            for cid in faltantes:
                cache[cid] = {}
        except Exception as err:
            print(f"  Error en lote {lote_num}: {err}", file=sys.stderr)
            for cid in lote:
                cache[cid] = {}

        if lote_num % 10 == 0 or lote_num == total_lotes:
            print(f"  Lote {lote_num}/{total_lotes} listo ({len(cache)} en caché)")

        time.sleep(REQUEST_DELAY_SEC)

    return cache


def recolectar_filas(client: KommoClient) -> list[tuple[str, str]]:
    candidatos: list[tuple[str, int | None, dict | None]] = []
    ids_a_descargar: set[int] = set()

    total_leads = 0

    print("Paso 1/2: Recorriendo leads en Kommo...")

    for lead in client.iter_leads():
        total_leads += 1
        nombre_lead = (lead.get("name") or "").strip()

        if not nombre_termina_en_dota(nombre_lead):
            continue

        contactos_embedded = (lead.get("_embedded") or {}).get("contacts") or []
        if not contactos_embedded:
            candidatos.append((nombre_lead, None, None))
            continue

        contacto_embedded = contactos_embedded[0]
        contacto_id = contacto_embedded.get("id")

        if not contacto_id:
            candidatos.append((nombre_lead, None, None))
            continue

        cid = int(contacto_id)
        telefono_embedded = obtener_telefono_oficina(contacto_embedded)

        if telefono_embedded:
            candidatos.append((nombre_lead, cid, contacto_embedded))
        else:
            candidatos.append((nombre_lead, cid, None))
            ids_a_descargar.add(cid)

        if len(candidatos) % 100 == 0:
            print(f"  ... {len(candidatos)} leads 'dota' encontrados")

    print(f"  Leads revisados: {total_leads}")
    print(f"  Candidatos 'dota': {len(candidatos)}")
    print(f"  Contactos a descargar: {len(ids_a_descargar)}")

    contacto_cache = cargar_contactos_por_lotes(client, ids_a_descargar)

    print("Paso 2/2: Armando filas del CSV...")

    vistos_telefono: set[str] = set()
    vistos_nombre: set[str] = set()
    filas: list[tuple[str, str]] = []
    omitidos_duplicado = 0
    omitidos_sin_telefono = 0

    for nombre_lead, contacto_id, contacto_embedded in candidatos:
        contacto = contacto_embedded

        if contacto_id and not contacto:
            contacto = contacto_cache.get(contacto_id) or {}

        telefono_raw = obtener_telefono_oficina(contacto) if contacto else None

        if not telefono_raw:
            omitidos_sin_telefono += 1
            continue

        telefono_norm = normalizar_telefono(telefono_raw)
        nombre_key = nombre_lead.lower()

        if telefono_norm:
            if telefono_norm in vistos_telefono:
                omitidos_duplicado += 1
                continue
            vistos_telefono.add(telefono_norm)
        else:
            if nombre_key in vistos_nombre:
                omitidos_duplicado += 1
                continue
            vistos_nombre.add(nombre_key)

        filas.append((nombre_lead, telefono_raw))

    filas.sort(key=lambda r: r[0].lower())

    print()
    print(f"Duplicados omitidos:    {omitidos_duplicado}")
    print(f"Sin teléfono omitidos:  {omitidos_sin_telefono}")
    print(f"Filas en CSV:           {len(filas)}")

    return filas


def escribir_csv(filas: list[tuple[str, str]], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f, delimiter=";")
        writer.writerow(["Nombre del lead", "Teléfono oficina (contacto)"])
        writer.writerows(filas)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Exporta leads Kommo que terminan en 'dota' a CSV."
    )
    parser.add_argument(
        "--output",
        "-o",
        default="leads_dota_kommo.csv",
        help="Ruta del archivo CSV de salida (default: leads_dota_kommo.csv)",
    )
    args = parser.parse_args()

    subdomain, token = load_env()
    client = KommoClient(subdomain, token)

    filas = recolectar_filas(client)
    output_path = Path(args.output).resolve()
    escribir_csv(filas, output_path)

    print(f"\nCSV generado: {output_path}")


if __name__ == "__main__":
    main()
