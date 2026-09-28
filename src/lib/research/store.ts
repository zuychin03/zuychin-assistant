import { supabaseAdmin } from "@/lib/supabase";
import { knowledgeRevisions } from "@/lib/knowledge/revision-store";
import { createResearchService } from "./service";
import { createResearchHandlers } from "./api";

export const researchService = createResearchService(supabaseAdmin, knowledgeRevisions);
export const researchHandlers = createResearchHandlers(researchService);
