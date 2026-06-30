import { Controller, Get, Query } from "@nestjs/common";
import { ok } from "../../common/api-response";
import { LibraryService } from "./library.service";
import type { FrontendKnowledgeType } from "./library.types";

@Controller("library")
export class LibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  @Get()
  async listLibraryItems(
    @Query("q") q = "",
    @Query("type") type?: FrontendKnowledgeType,
  ) {
    const items = await this.libraryService.listItems({ q, type });
    return ok({ items, source: "postgres" });
  }
}
