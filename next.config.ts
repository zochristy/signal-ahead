import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 폰 등 같은 와이파이의 다른 기기에서 LAN IP로 접속 시
  // Next dev 리소스(HMR·청크) 차단 방지.
  // DHCP로 IP가 바뀌어도(예: .11 ↔ .139) 안 깨지게 서브넷 전체 허용.
  allowedDevOrigins: ["192.168.0.*"],
};

export default nextConfig;
