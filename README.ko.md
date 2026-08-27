# CesiumJS COPC Runtime

3D Tiles 사전 변환 없이 COPC를 CesiumJS에서 직접 스트리밍하고 분석하는
오픈소스 런타임입니다.

[English](README.md) ·
[라이브 데모](https://yangseungsang.github.io/cesiumjs-copc-runtime/) ·
[시작하기](docs/getting-started.md) ·
[아키텍처](docs/architecture.md) ·
[벤치마크](docs/benchmarks.md)

![CesiumJS COPC Runtime 대표 이미지](docs/assets/cesiumjs-copc-runtime-hero.png)

## 핵심 가치

기존 포인트 클라우드 웹 서비스는 원본을 별도의 서비스 형식으로 변환하는 경우가
많습니다. 이 프로젝트는 COPC가 이미 제공하는 Range-addressable Octree를 활용해
현재 카메라에 필요한 hierarchy와 node chunk만 요청합니다.

- 원본 COPC 하나를 가시화와 분석에 함께 사용
- HTTP Range Request와 인접 범위 병합
- 카메라 기반 additive LoD와 기기별 point budget
- Worker LAZ decode와 상대 ECEF `Float32` 렌더 좌표
- 원본 CRS `Float64` 좌표 및 LAS attribute 보존
- 국내 좌표계, 명시적 EGM96 보정, 공간 질의와 높이 프로파일

## 3D Tiles 변환 경로와의 비교

| 축                    | 3D Tiles 변환 경로     | 이 프로젝트         |
| --------------------- | ---------------------- | ------------------- |
| 첫 화면 전 사전 처리  | 전체 데이터 변환 필요  | 없음                |
| 그 변환의 하한        | 최소 약 3분 11초       | 0초                 |
| 저장해야 하는 사본 수 | 2벌(원본과 타일셋)     | 1벌(원본)           |
| 원본 갱신 시 비용     | 재변환                 | 없음                |
| 분석 가능한 속성      | 변환 시 선택한 것만    | 모든 LAS dimension  |

각 수치를 실측, 구조적 사실, 하한 추정으로 구분해 표기한 근거와, 반대로 3D Tiles
변환이 여전히 유리한 경우는 [파이프라인 비교](docs/pipeline-comparison.md)에
정리했습니다.

## 검증 현황

| 항목             |                                       결과 |
| ---------------- | -----------------------------------------: |
| Unit Test        |                     15개 파일, 58개 테스트 |
| CI               |                             Node.js 20, 22 |
| Browser Test     |                        Chromium smoke test |
| 기준 데이터      |               10,653,336 points / 77.4 MiB |
| 기준 View 전송량 |                                 약 3.0 MiB |
| Decode           | 269,241 points / 중앙값 약 55,875 points/s |

수치는 실행 환경에 따라 달라질 수 있으므로 [측정 방법](docs/benchmarks.md)을 함께
확인해야 합니다.

## 실행

```sh
git clone https://github.com/yangseungsang/cesiumjs-copc-runtime.git
cd cesiumjs-copc-runtime
npm ci
npm run build
npm run demo
```

서버는 CORS와 HTTP `206 Partial Content`를 지원해야 합니다. 자세한 설정과 문제
해결 방법은 [Getting Started](docs/getting-started.md)와
[Troubleshooting](docs/troubleshooting.md)을 참고하세요.

이 프로젝트는 독립 오픈소스 프로젝트이며 Cesium의 공식 프로젝트가 아닙니다.
[MIT License](LICENSE)로 배포됩니다.
