FROM python:3.13.5-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/cache

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN python -m pip install --upgrade pip \
    && python -m pip install -r requirements.txt

COPY service.py ./service.py
COPY vendor ./vendor

EXPOSE 10002
CMD ["python", "service.py"]
