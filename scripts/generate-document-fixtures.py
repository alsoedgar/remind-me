from __future__ import annotations

import argparse
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
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
PHASE0_HYBRID_PDF = OUTPUT / "phase0-hybrid-table.pdf"
PHASE0_MULTIPAGE_PDF = OUTPUT / "phase0-multipage-syllabus.pdf"
PHASE0_MONTH_GRID = OUTPUT / "phase0-month-grid.png"
PHASE0_PHONE_PHOTO = OUTPUT / "phase0-phone-itinerary.jpg"
PHASE0_FLYER = OUTPUT / "phase0-event-flyer.webp"
PHASE0_ROTATED_PDF = OUTPUT / "phase0-rotated-schedule.pdf"

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
    pdf = canvas.Canvas(str(NATIVE_PDF), pagesize=letter, pageCompression=1, invariant=1)
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
    pdf = canvas.Canvas(str(SCANNED_PDF), pagesize=letter, pageCompression=1, invariant=1)
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
    pdf = canvas.Canvas(str(PHASE7_NATIVE_PDF), pagesize=page_size, pageCompression=1, invariant=1)
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
    pdf = canvas.Canvas(
        str(PHASE7_SCANNED_PDF), pagesize=page_size, pageCompression=1, invariant=1
    )
    pdf.drawImage(
        ImageReader(buffer),
        0,
        0,
        width=page_size[0],
        height=page_size[1],
        preserveAspectRatio=True,
    )
    pdf.save()


def make_phase0_hybrid_pdf(image: Image.Image) -> None:
    """A raster schedule with enough selectable chrome to expose hybrid-PDF OCR gating."""
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=90, optimize=True)
    buffer.seek(0)
    page_size = landscape(letter)
    pdf = canvas.Canvas(
        str(PHASE0_HYBRID_PDF), pagesize=page_size, pageCompression=1, invariant=1
    )
    width, height = page_size
    pdf.drawImage(ImageReader(buffer), 0, 0, width=width, height=height, preserveAspectRatio=False)
    pdf.setFillColorRGB(0.18, 0.16, 0.14)
    pdf.setFont("Helvetica", 8)
    pdf.drawString(34, 15, "Private local evaluation copy - raster schedule body")
    pdf.save()


def make_phase0_multipage_syllabus_pdf() -> None:
    pdf = canvas.Canvas(
        str(PHASE0_MULTIPAGE_PDF), pagesize=letter, pageCompression=1, invariant=1
    )
    width, height = letter

    def page_frame(page_number: int, heading: str, subtitle: str) -> float:
        pdf.setFillColorRGB(0.96, 0.93, 0.87)
        pdf.rect(0, 0, width, height, fill=1, stroke=0)
        pdf.setFillColorRGB(1, 0.985, 0.95)
        pdf.setStrokeColorRGB(0.18, 0.16, 0.14)
        pdf.setLineWidth(1.5)
        pdf.roundRect(38, 34, width - 76, height - 68, 14, fill=1, stroke=1)
        pdf.setFillColorRGB(0.18, 0.16, 0.14)
        pdf.setFont("Helvetica-Bold", 23)
        pdf.drawString(66, height - 86, heading)
        pdf.setFont("Helvetica", 10)
        pdf.setFillColorRGB(0.43, 0.39, 0.36)
        pdf.drawString(67, height - 108, subtitle)
        pdf.drawRightString(width - 66, 52, f"Page {page_number} of 2")
        return height - 155

    y = page_frame(1, "CS 199 COURSE SYLLABUS", "Fall 2026 - sanitized evaluation fixture")
    page_one_lines = [
        ("Weekly lecture", "title"),
        ("August 24, 2026 - December 4, 2026", "date"),
        ("Every Monday and Wednesday", "body"),
        ("10:00 AM - 10:50 AM", "time"),
        ("Location: Room 201", "body"),
        ("", "gap"),
        ("Course practices", "title"),
        ("Bring questions, take breaks, and keep a private copy of your work.", "body"),
    ]
    for text, style in page_one_lines:
        if style == "gap":
            y -= 28
            continue
        pdf.setFont("Helvetica-Bold" if style in {"title", "date"} else "Helvetica", 15 if style == "title" else 12)
        pdf.setFillColorRGB(0.61, 0.37, 0.27) if style == "date" else pdf.setFillColorRGB(0.18, 0.16, 0.14)
        pdf.drawString(74, y, text)
        y -= 28 if style == "title" else 23
    pdf.showPage()

    y = page_frame(2, "KEY DATES", "Review dates and times before adding them")
    page_two_lines = [
        ("September 28, 2026", "date"),
        ("Midterm exam", "title"),
        ("10:00 AM - 10:50 AM", "time"),
        ("Location: Room 201", "body"),
        ("", "gap"),
        ("Reminder: Submit final project", "title"),
        ("Due October 30, 2026 at 11:59 PM", "time"),
        ("", "gap"),
        ("Asynchronous reflection", "title"),
        ("Available November 2, 2026", "date"),
        ("ARR - no fixed meeting time", "body"),
    ]
    for text, style in page_two_lines:
        if style == "gap":
            y -= 24
            continue
        pdf.setFont("Helvetica-Bold" if style in {"title", "date"} else "Helvetica", 15 if style == "title" else 12)
        pdf.setFillColorRGB(0.61, 0.37, 0.27) if style == "date" else pdf.setFillColorRGB(0.18, 0.16, 0.14)
        pdf.drawString(74, y, text)
        y -= 28 if style == "title" else 23
    pdf.save()


def make_phase0_month_grid() -> Image.Image:
    image = Image.new("RGB", (1600, 1200), "#eee1d0")
    draw = ImageDraw.Draw(image)
    font_file = font_path()
    heading = ImageFont.truetype(str(font_file), 58)
    weekday = ImageFont.truetype(str(font_file), 24)
    day_font = ImageFont.truetype(str(font_file), 25)
    item_font = ImageFont.truetype(str(font_file), 22)
    draw.rounded_rectangle((55, 50, 1545, 1150), radius=32, fill="#fffaf0", outline="#2d2924", width=5)
    draw.text((95, 86), "SEPTEMBER 2026", font=heading, fill="#2d2924")
    weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
    left, top, cell_width, cell_height = 92, 210, 202, 166
    for column, label in enumerate(weekdays):
        draw.text((left + column * cell_width + 12, top - 42), label, font=weekday, fill="#79513e")
    day = 30
    entries = {
        8: ["Team sync", "9:00 AM", "Studio A"],
        14: ["Dentist", "3:30 PM", "Clinic 4"],
        25: ["Reminder:", "Rent due", "5:00 PM"],
    }
    for row in range(5):
        for column in range(7):
            x = left + column * cell_width
            y = top + row * cell_height
            draw.rounded_rectangle((x, y, x + cell_width - 10, y + cell_height - 10), radius=8, fill="#f8ecdc", outline="#b89f8a", width=2)
            if row == 0 and column < 2:
                display_day = day
                day += 1
                color = "#a4978b"
            else:
                display_day = row * 7 + column - 1
                if display_day <= 0 or display_day > 30:
                    continue
                color = "#2d2924"
            draw.text((x + 12, y + 10), str(display_day), font=day_font, fill=color)
            for index, line in enumerate(entries.get(display_day, [])):
                draw.text((x + 12, y + 50 + index * 27), line, font=item_font, fill="#2d2924")
    return image


def make_phase0_phone_photo() -> Image.Image:
    canvas_image = Image.new("RGB", (1350, 1800), "#8c8178")
    shadow = Image.new("RGBA", canvas_image.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle((160, 135, 1190, 1680), radius=36, fill=(20, 16, 14, 125))
    shadow = shadow.filter(ImageFilter.GaussianBlur(24))
    canvas_image.paste(shadow, (0, 0), shadow)
    card = Image.new("RGB", (1030, 1545), "#fffaf0")
    draw = ImageDraw.Draw(card)
    font_file = font_path()
    heading = ImageFont.truetype(str(font_file), 58)
    title = ImageFont.truetype(str(font_file), 39)
    body = ImageFont.truetype(str(font_file), 30)
    subtle = ImageFont.truetype(str(font_file), 24)
    draw.rounded_rectangle((4, 4, 1025, 1540), radius=34, fill="#fffaf0", outline="#2d2924", width=5)
    draw.text((70, 70), "TRIP PLAN", font=heading, fill="#2d2924")
    draw.text((72, 142), "A private itinerary", font=subtle, fill="#6d645c")
    itinerary = [
        ("Flight to Seattle", "August 26, 2026", "10:00 AM - 12:30 PM", "Terminal 2, Gate C12"),
        ("Hotel check-in", "August 26, 2026", "3:00 PM", "Pine Hotel"),
        ("Museum tickets", "August 27, 2026", "11:00 AM - 1:00 PM", "City Museum"),
    ]
    y = 245
    for index, (name, date, time, place) in enumerate(itinerary):
        fill = "#f6e6d4" if index % 2 == 0 else "#efe0d0"
        draw.rounded_rectangle((62, y, 965, y + 315), radius=22, fill=fill, outline="#9c8573", width=3)
        draw.text((95, y + 35), name, font=title, fill="#2d2924")
        draw.text((95, y + 105), date, font=body, fill="#8c543f")
        draw.text((95, y + 160), time, font=body, fill="#2d2924")
        draw.text((95, y + 215), place, font=body, fill="#2d2924")
        y += 350
    rotated = card.rotate(2.4, resample=Image.Resampling.BICUBIC, expand=True, fillcolor="#8c8178")
    canvas_image.paste(rotated, ((canvas_image.width - rotated.width) // 2, 90))
    glare = Image.new("RGBA", canvas_image.size, (0, 0, 0, 0))
    glare_draw = ImageDraw.Draw(glare)
    glare_draw.polygon([(930, 0), (1350, 0), (1350, 620), (1120, 760)], fill=(255, 255, 255, 32))
    canvas_image.paste(glare, (0, 0), glare)
    return canvas_image


def make_phase0_flyer() -> Image.Image:
    image = Image.new("RGB", (1200, 1500), "#3f6657")
    draw = ImageDraw.Draw(image)
    font_file = font_path()
    heading = ImageFont.truetype(str(font_file), 74)
    title = ImageFont.truetype(str(font_file), 52)
    body = ImageFont.truetype(str(font_file), 38)
    draw.rounded_rectangle((70, 70, 1130, 1430), radius=48, fill="#f7ead5", outline="#2d2924", width=6)
    draw.ellipse((770, 105, 1040, 375), fill="#d88965", outline="#2d2924", width=5)
    draw.text((125, 155), "RIVER PARK", font=heading, fill="#2d2924")
    draw.text((125, 255), "NIGHT MARKET", font=heading, fill="#2d2924")
    draw.line((125, 390, 1060, 390), fill="#947b68", width=4)
    draw.text((125, 485), "Saturday, September 5, 2026", font=title, fill="#8c543f")
    draw.text((125, 610), "5:00 PM - 9:00 PM", font=title, fill="#2d2924")
    draw.text((125, 735), "River Park Pavilion", font=title, fill="#2d2924")
    draw.text((125, 930), "Food, music, makers, and neighbors.", font=body, fill="#4e4740")
    draw.text((125, 1010), "Admission is free.", font=body, fill="#4e4740")
    return image


def make_phase0_rotated_pdf(image: Image.Image) -> None:
    rotated = image.rotate(90, expand=True)
    buffer = BytesIO()
    rotated.save(buffer, format="JPEG", quality=90, optimize=True)
    buffer.seek(0)
    pdf = canvas.Canvas(
        str(PHASE0_ROTATED_PDF), pagesize=letter, pageCompression=1, invariant=1
    )
    pdf.drawImage(ImageReader(buffer), 0, 0, width=letter[0], height=letter[1], preserveAspectRatio=False)
    pdf.save()


def make_phase0_fixtures(vertical_image: Image.Image, table_image: Image.Image) -> None:
    make_phase0_hybrid_pdf(table_image)
    make_phase0_multipage_syllabus_pdf()
    make_phase0_month_grid().save(PHASE0_MONTH_GRID, format="PNG", optimize=True)
    make_phase0_phone_photo().save(PHASE0_PHONE_PHOTO, format="JPEG", quality=88, optimize=True)
    make_phase0_flyer().save(PHASE0_FLYER, format="WEBP", quality=92, method=6)
    make_phase0_rotated_pdf(vertical_image)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate sanitized document evaluation fixtures")
    parser.add_argument(
        "--phase0-only",
        action="store_true",
        help="Create the Phase 0 expansion without rewriting the earlier checkpoint fixtures",
    )
    arguments = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    image = make_image()
    phase7_image = make_phase7_image()
    if not arguments.phase0_only:
        image.save(IMAGE_FILE, format="PNG", optimize=True)
        make_native_pdf()
        make_scanned_pdf(image)
        phase7_image.save(PHASE7_IMAGE_FILE, format="PNG", optimize=True)
        make_phase7_native_pdf()
        make_phase7_scanned_pdf(phase7_image)
    make_phase0_fixtures(image, phase7_image)
    print(f"Generated document fixtures in {OUTPUT}")


if __name__ == "__main__":
    main()
