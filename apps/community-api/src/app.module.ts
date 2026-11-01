import { Controller, Get, Header, Module } from "@nestjs/common";

@Controller("health")
export class HealthController {
  /** This checks the API process only; databases and Connector are not checked. */
  @Get()
  @Header("Cache-Control", "no-store")
  health(): { status: "ok"; service: "community-api" } {
    return { status: "ok", service: "community-api" };
  }
}

@Module({ controllers: [HealthController] })
export class AppModule {}
