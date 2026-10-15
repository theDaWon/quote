/*
  [설정 파일] 배포 후 아래 두 값만 바꾸면 됩니다. (README 참고)
  - WORKER_URL       : Cloudflare Worker 주소 (끝에 / 없이)
  - TURNSTILE_SITEKEY: Cloudflare Turnstile의 "사이트 키" (공개용, 비밀키 아님)
  ※ 비밀키(Secret Key)는 절대 이 파일이나 GitHub에 넣지 마세요.
*/
window.DWQ_CONFIG = {
  WORKER_URL: 'https://dawon-quote.dawonsafety1.workers.dev',
  TURNSTILE_SITEKEY: '0x4AAAAAAFXTFaVg6cM54yKp'
};
