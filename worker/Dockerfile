FROM node:20-slim

# Native tools for the extraction cascade:
#   poppler-utils -> pdftotext ; qpdf -> empty-password decrypt ; ocrmypdf+tesseract -> OCR scans
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      qpdf \
      tesseract-ocr \
      ocrmypdf \
      ghostscript \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY *.mjs ./

ENV NODE_ENV=production
# Cloud Run injects PORT; default 8080 for local runs.
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.mjs"]
