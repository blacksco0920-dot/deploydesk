import { Controller, Get } from "@nestjs/common";

@Controller()
export class AppController {
  @Get("health")
  health() {
    return { status: "ok" };
  }

  @Get("hello")
  hello() {
    return {
      message: process.env.API_GREETING ?? "Hello from ABCDeploy",
    };
  }
}
