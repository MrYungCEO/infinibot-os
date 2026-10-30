FROM nvidia/cuda:12.8.1-devel-ubuntu24.04 AS builder

ARG DEBIAN_FRONTEND=noninteractive
ARG COLMAP_REF=3.12.3
ARG OPENMVS_REF=v2.3.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates cmake git ninja-build \
    libboost-graph-dev libboost-program-options-dev libboost-system-dev \
    libceres-dev libcgal-dev libeigen3-dev libfreeimage-dev libglew-dev \
    libglfw3-dev libgmp-dev libgoogle-glog-dev libjpeg-dev libmetis-dev \
    libmpfr-dev libpng-dev libsqlite3-dev libtiff-dev libxi-dev libxxf86vm-dev \
    libopencv-dev libopenexr-dev libtbb-dev && \
    rm -rf /var/lib/apt/lists/*

# CUDA 12.8 is required for Blackwell (RTX 5090/5080, sm_120). Keep Ada sm_89
# so the same worker image also runs on RTX 40-series machines.
RUN git clone --branch "${COLMAP_REF}" --depth 1 https://github.com/colmap/colmap.git /src/colmap && \
    cmake -S /src/colmap -B /build/colmap -GNinja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_CUDA_ARCHITECTURES="89;120" \
      -DGUI_ENABLED=OFF -DTESTS_ENABLED=OFF && \
    cmake --build /build/colmap --parallel "$(nproc)" && \
    cmake --install /build/colmap

RUN git clone --branch "${OPENMVS_REF}" --depth 1 --recursive https://github.com/cdcseacave/openMVS.git /src/openmvs && \
    cmake -S /src/openmvs -B /build/openmvs -GNinja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_CUDA_ARCHITECTURES="89;120" \
      -DOpenMVS_USE_CUDA=ON -DOpenMVS_BUILD_TOOLS=ON && \
    cmake --build /build/openmvs --parallel "$(nproc)" && \
    cmake --install /build/openmvs

FROM nvidia/cuda:12.8.1-runtime-ubuntu24.04

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip libboost-program-options1.83.0 libfreeimage3 libgomp1 \
    libgl1 libglu1-mesa libopencv-core406 libopencv-imgproc406 libsqlite3-0 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/ /usr/local/
RUN python3 -m pip install --break-system-packages --no-cache-dir \
    numpy==2.2.6 scipy==1.15.3 opencv-contrib-python-headless==4.11.0.86 \
    trimesh==4.6.12 pillow==11.2.1

WORKDIR /opt/part-scan
COPY pipeline.py /opt/part-scan/pipeline.py
ENV PATH="/usr/local/bin:${PATH}" PYTHONUNBUFFERED=1
ENTRYPOINT ["python3", "/opt/part-scan/pipeline.py"]
