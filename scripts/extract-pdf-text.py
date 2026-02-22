import re
from pathlib import Path

from pypdf import PdfReader


def normalize_text(text: str) -> str:
    # Keep it simple: collapse excessive whitespace, preserve line breaks.
    # Many API PDFs have awkward spacing; this makes grep/search usable.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    pdf_path = Path(r"C:\Users\Tay Liku\OneDrive\Desktop\dotnet-api-_splitted-system.windows.automation-windowsdesktop-11.0.pdf")
    out_txt = repo_root / "docs" / "pdf" / "system.windows.automation-windowsdesktop-11.0.txt"
    out_index = repo_root / "docs" / "pdf" / "system.windows.automation-windowsdesktop-11.0.index.txt"

    if not pdf_path.exists():
        raise SystemExit(f"PDF not found: {pdf_path}")

    reader = PdfReader(str(pdf_path))

    chunks: list[str] = []
    index_hits: list[str] = []
    index_terms = [
        "AutomationElement",
        "AutomationPattern",
        "InvokePattern",
        "ValuePattern",
        "SelectionPattern",
        "TextPattern",
        "TransformPattern",
        "WindowPattern",
        "AutomationEvent",
        "AutomationProperty",
        "AutomationFocusChangedEventHandler",
        "StructureChangedEventHandler",
        "Automation.Add",
        "Automation.Remove",
        "TreeWalker",
        "Condition",
        "PropertyCondition",
        "AndCondition",
        "OrCondition",
        "CacheRequest",
        "BoundingRectangle",
        "FromHandle",
        "FromPoint",
        "ElementFromHandle",
        "ElementFromPoint",
    ]

    for i, page in enumerate(reader.pages, start=1):
        page_text = page.extract_text() or ""
        if not page_text.strip():
            continue
        page_text = normalize_text(page_text)
        chunks.append(f"\n\n=== Page {i} ===\n\n{page_text}")

        # crude index: record first matching line containing term
        lowered = page_text.lower()
        for term in index_terms:
            if term.lower() in lowered:
                # grab a nearby snippet (first occurrence line-ish)
                idx = lowered.find(term.lower())
                start = max(0, idx - 80)
                end = min(len(page_text), idx + 160)
                snippet = page_text[start:end].replace("\n", " ").strip()
                index_hits.append(f"Page {i}: {term}: {snippet}")

    out_txt.write_text("".join(chunks).lstrip() + "\n", encoding="utf-8")
    out_index.write_text("\n".join(sorted(set(index_hits))) + "\n", encoding="utf-8")

    print(f"Wrote: {out_txt}")
    print(f"Wrote: {out_index}")
    print(f"Pages processed: {len(reader.pages)}")


if __name__ == "__main__":
    main()
