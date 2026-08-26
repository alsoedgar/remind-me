from __future__ import annotations

from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "fixtures" / "documents"
NATIVE_PDF = OUTPUT / "phase4-schedule.pdf"
SCANNED_PDF = OUTPUT / "phase4-scanned-schedule.pdf"
IMAGE_FILE = OUTPUT / "phase4-schedule.png"
PHASE7_NATIVE_PDF = OUTPUT / "phase7-table-plan.pdf"
PHASE7_SCANNED_PDF = OUTPUT / "phase7-scanned-table-plan.pdf"
PHASE7_IMAGE_FILE = OUTPUT / "phase7-table-plan.png"

LINES = [
    ("COZY WEEK PLAN", "heading"),
    ("Prepared for local calendar import", "subtle"),
    ("", "gap"),
    ("August 26, 2026", "date"),
    ("Project kickoff", "title"),
    ("9:00 AM - 10:00 AM", "time"),
    ("Location: Studio A", "body"),
    ("", "gap"),
    ("August 28, 2026", "date"),
    ("Design review", "title"),
    ("2:00 PM - 3:30 PM", "time"),
    ("Location: Reading Room", "body"),
    ("", "gap"),
    ("Reminder: Submit portfolio", "title"),
    ("Due August 30, 2026 at 6:00 PM", "time"),
]

PHASE7_ROWS = [
    ("Project kickoff", "August 26, 2026", "9:00 AM - 10:00 AM", "Studio A"),
    ("Design review", "August 28, 2026", "2:00 PM - 3:30 PM", "Reading Room"),
    ("Reminder: Submit portfolio", "August 30, 2026", "6:00 PM", "Online"),
    ("Community meeting", "September 2, 2026", "7:15 PM", "North Hall"),
]


def font_path() -> Path:
    candidates = [
        Path("C:/Windows/Fonts/arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise RuntimeError("A readable sans-serif font is required for the OCR fixture")


def make_image() -> Image.Image:
    image = Image.new("RGB", (1275, 1650), "#f8f1e4")
    draw = ImageDraw.Draw(image)
    font_file = font_path()
    fonts = {
        "heading": ImageFont.truetype(str(font_file), 60),
        "subtle": ImageFont.truetype(str(font_file), 25),
        "date": ImageFont.truetype(str(font_file), 36),
        "title": ImageFont.truetype(str(font_file), 42),
        "time": ImageFont.truetype(str(font_file), 34),
        "body": ImageFont.truetype(str(font_file), 30),
    }
    colors = {
        "heading": "#2d2924",
        "subtle": "#6d645c",
        "date": "#9b5f46",
        "title": "#2d2924",
        "time": "#2d2924",
        "body": "#4e4740",
    }
    draw.rounded_rectangle((84, 70, 1191, 1580), radius=32, fill="#fffaf0", outline="#2d2924", width=4)
    draw.ellipse((930, 92, 1060, 222), fill="#d9906f", outline="#2d2924", width=4)
    y = 130
    for text, style in LINES:
        if style == "gap":
            y += 44
            continue
        font = fonts[style]
        draw.text((135, y), text, font=font, fill=colors[style])
        if style == "heading":
            y += 80
        elif style == "subtle":
            y += 55
            draw.line((135, y, 1110, y), fill="#b8a99a", width=3)
            y += 30
        elif style == "date":
            y += 58
        elif style == "title":
            y += 64
        else:
            y += 50
    return image


def make_native_pdf() -> None:
    pdf = canvas.Canvas(str(NATIVE_PDF), pagesize=letter, pageCompression=1)
    width, height = letter
    pdf.setFillColorRGB(0.973, 0.945, 0.894)
    pdf.rect(0, 0, width, height, fill=1, stroke=0)
    pdf.setFillColorRGB(1, 0.98, 0.94)
    pdf.setStrokeColorRGB(0.18, 0.16, 0.14)
    pdf.setLineWidth(1.5)
    pdf.roundRect(42, 38, width - 84, height - 76, 16, fill=1, stroke=1)
    y = height - 88
    for text, style in LINES:
        if style == "gap":
            y -= 18
            continue
        if style == "heading":
            pdf.setFont("Helvetica-Bold", 25)
            pdf.setFillColorRGB(0.18, 0.16, 0.14)
            leading = 32
        elif style == "subtle":
            pdf.setFont("Helvetica", 10)
            pdf.setFillColorRGB(0.43, 0.39, 0.36)
            leading = 25
        elif style == "date":
            pdf.setFont("Helvetica-Bold", 15)
            pdf.setFillColorRGB(0.61, 0.37, 0.27)
            leading = 24
        elif style == "title":
            pdf.setFont("Helvetica-Bold", 17)
            pdf.setFillColorRGB(0.18, 0.16, 0.14)
            leading = 25
        elif style == "time":
            pdf.setFont("Helvetica", 14)
            pdf.setFillColorRGB(0.18, 0.16, 0.14)
            leading = 21
        else:
            pdf.setFont("Helvetica", 12)
            pdf.setFillColorRGB(0.31, 0.28, 0.25)
            leading = 20
        pdf.drawString(70, y, text)
        y -= leading
    pdf.save()


def make_scanned_pdf(image: Image.Image) -> None:
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=92, optimize=True)
    buffer.seek(0)
    pdf = canvas.Canvas(str(SCANNED_PDF), pagesize=letter, pageCompression=1)
    pdf.drawImage(ImageReader(buffer), 0, 0, width=letter[0], height=letter[1], preserveAspectRatio=True)
    pdf.save()


def make_phase7_image() -> Image.Image:
    image = Image.new("RGB", (1650, 1275), "#f3e7d4")
    draw = ImageDraw.Draw(image)
    font_file = font_path()
    heading = ImageFont.truetype(str(font_file), 58)
    subtitle = ImageFont.truetype(str(font_file), 25)
    column = ImageFont.truetype(str(font_file), 27)
    body = ImageFont.truetype(str(font_file), 25)
    draw.rounded_rectangle((60, 54, 1590, 1218), radius=34, fill="#fffaf0", outline="#2d2924", width=5)
    draw.text((105, 95), "RIVERGLASS WEEK", font=heading, fill="#2d2924")
    draw.text((108, 174), "A row-based schedule for local PlanScan review", font=subtitle, fill="#6d645c")
    draw.ellipse((1430, 90, 1535, 195), fill="#d9906f", outline="#2d2924", width=4)
    columns = [("PLAN", 105), ("DATE", 575), ("TIME", 920), ("PLACE", 1260)]
    top = 260
    draw.rounded_rectangle((92, top - 22, 1554, top + 56), radius=12, fill="#e8c7ad", outline="#2d2924", width=3)
    for label, x in columns:
        draw.text((x, top), label, font=column, fill="#2d2924")
    y = top + 94
    for row_index, row in enumerate(PHASE7_ROWS):
        fill = "#fff4e5" if row_index % 2 == 0 else "#f7ead9"
        draw.rounded_rectangle((92, y - 20, 1554, y + 83), radius=10, fill=fill, outline="#9c8573", width=2)
        for value, (_, x) in zip(row, columns):
            draw.text((x, y + 8), value, font=body, fill="#2d2924")
        y += 132
    draw.text((108, 1118), "Every proposal stays editable until you confirm it.", font=subtitle, fill="#6d645c")
    return image


def make_phase7_native_pdf() -> None:
    page_size = landscape(letter)
    pdf = canvas.Canvas(str(PHASE7_NATIVE_PDF), pagesize=page_size, pageCompression=1)
    width, height = page_size
    pdf.setFillColorRGB(0.95, 0.91, 0.84)
    pdf.rect(0, 0, width, height, fill=1, stroke=0)
    pdf.setFillColorRGB(1, 0.98, 0.94)
    pdf.setStrokeColorRGB(0.18, 0.16, 0.14)
    pdf.setLineWidth(1.8)
    pdf.roundRect(28, 26, width - 56, height - 52, 15, fill=1, stroke=1)
    pdf.setFont("Helvetica-Bold", 25)
    pdf.setFillColorRGB(0.18, 0.16, 0.14)
    pdf.drawString(52, height - 72, "RIVERGLASS WEEK")
    pdf.setFont("Helvetica", 10)
    pdf.setFillColorRGB(0.43, 0.39, 0.36)
    pdf.drawString(53, height - 94, "A row-based schedule for local PlanScan review")
    column_x = [53, 285, 455, 620]
    column_widths = [220, 160, 155, 120]
    table_top = height - 135
    pdf.setFillColorRGB(0.91, 0.78, 0.68)
    pdf.roundRect(44, table_top - 20, width - 88, 38, 7, fill=1, stroke=1)
    pdf.setFillColorRGB(0.18, 0.16, 0.14)
    pdf.setFont("Helvetica-Bold", 11)
    for label, x in zip(("PLAN", "DATE", "TIME", "PLACE"), column_x):
        pdf.drawString(x, table_top - 7, label)
    y = table_top - 72
    for row_index, row in enumerate(PHASE7_ROWS):
        if row_index % 2 == 0:
            pdf.setFillColorRGB(1, 0.96, 0.9)
        else:
            pdf.setFillColorRGB(0.97, 0.92, 0.85)
        pdf.roundRect(44, y - 16, width - 88, 45, 5, fill=1, stroke=1)
        pdf.setFillColorRGB(0.18, 0.16, 0.14)
        pdf.setFont("Helvetica", 10)
        for value, x, maximum_width in zip(row, column_x, column_widths):
            clipped = value if pdf.stringWidth(value, "Helvetica", 10) <= maximum_width else value[:28]
            pdf.drawString(x, y, clipped)
        y -= 58
    pdf.setFont("Helvetica", 9)
    pdf.setFillColorRGB(0.43, 0.39, 0.36)
    pdf.drawString(53, 45, "Every proposal stays editable until you confirm it.")
    pdf.save()


def make_phase7_scanned_pdf(image: Image.Image) -> None:
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=90, optimize=True)
    buffer.seek(0)
    page_size = landscape(letter)
    pdf = canvas.Canvas(str(PHASE7_SCANNED_PDF), pagesize=page_size, pageCompression=1)
    pdf.drawImage(
        ImageReader(buffer),
        0,
        0,
        width=page_size[0],
        height=page_size[1],
        preserveAspectRatio=True,
    )
    pdf.save()


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    image = make_image()
    image.save(IMAGE_FILE, format="PNG", optimize=True)
    make_native_pdf()
    make_scanned_pdf(image)
    phase7_image = make_phase7_image()
    phase7_image.save(PHASE7_IMAGE_FILE, format="PNG", optimize=True)
    make_phase7_native_pdf()
    make_phase7_scanned_pdf(phase7_image)
    print(f"Generated document fixtures in {OUTPUT}")


if __name__ == "__main__":
    main()
