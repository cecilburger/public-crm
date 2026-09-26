# The BD brain as a container, for docker-compose next to the api/worker.
# Same shape as ops/Dockerfile: unprivileged user, a healthcheck the
# orchestrator can read, no dev tooling in the image.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app/src

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

RUN addgroup --gid 10001 bdbrain && adduser --disabled-password --gecos '' --uid 10001 --gid 10001 bdbrain
COPY --chown=bdbrain:bdbrain src ./src
USER bdbrain

# Google OAuth token and client (see .env.example) are mounted here at run
# time, never baked in.
VOLUME ["/app/secrets"]
EXPOSE 4321
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:4321/healthz', timeout=2).status == 200 else 1)"
CMD ["python", "-m", "bd_bot", "brain-serve", "--host", "0.0.0.0"]
