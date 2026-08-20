FROM node:20-slim

# Native tools for the extraction cascade:
#   poppler-utils -> pdftotext + pdfinfo ; qpdf -> empty-password decrypt
#   ocrmypdf+tesseract -> OCR scans ; imagemagick -> HEIC/TIFF/BMP conversion plus
#   EXIF auto-orient and downscaling for phone photos ; libheif -> the HEIC delegate
#   (heif-convert is the fallback when ImageMagick was built without it)
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      qpdf \
      tesseract-ocr \
      ocrmypdf \
      ghostscript \
      imagemagick \
      libheif1 \
      libheif-examples \
    && rm -rf /var/lib/apt/lists/*

# Debian ships an ImageMagick policy that blocks writing PDFs (the CVE-2016-3714
# era hardening). TIFF -> PDF is how multi-page scans reach OCR, and the input is
# bytes we just downloaded from our own Storage bucket, so allow that one coder.
RUN f=/etc/ImageMagick-6/policy.xml; \
    if [ -f "$f" ]; then \
      sed -i 's#<policy domain="coder" rights="none" pattern="PDF"#<policy domain="coder" rights="read|write" pattern="PDF"#' "$f"; \
    fi

WORKDIR /app
COPY package.json ./
COPY *.mjs ./

ENV NODE_ENV=production
# Cloud Run injects PORT; default 8080 for local runs.
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.mjs"]
