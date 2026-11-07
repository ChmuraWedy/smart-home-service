# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm
WORKDIR /app
RUN pip install --no-cache-dir ctranslate2==4.6.0 sentencepiece==0.2.1 fasttext-wheel==0.9.2 numpy==1.26.4
ARG MODEL=https://huggingface.co/auralmira/m2m100-418M-ct2-int8/resolve/e205afefce2fd6933a1dca3b92b5063894f2f2bb
ADD --chmod=0644 --checksum=sha256:137949450f9cf691f3c92084f14123e82d05ecb23ac3cd688308ce1a95214572 ${MODEL}/model.bin /models/model.bin
ADD --chmod=0644 --checksum=sha256:d8f7c76ed2a5e0822be39f0a4f95a55eb19c78f4593ce609e2edbc2aea4d380a ${MODEL}/sentencepiece.bpe.model /models/sentencepiece.bpe.model
ADD --chmod=0644 ${MODEL}/config.json /models/config.json
ADD --chmod=0644 ${MODEL}/shared_vocabulary.json /models/shared_vocabulary.json
ADD --chmod=0644 https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz /models/lid.176.ftz
COPY --chmod=0644 server.py .
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 CT2_USE_MKL=0
USER 1000:1000
CMD ["python", "/app/server.py"]
