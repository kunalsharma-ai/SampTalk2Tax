-- Financial dimensions: departments (cost centres) and projects, and the journal and document lines tagged with them.

-- CreateEnum
CREATE TYPE "DimensionType" AS ENUM ('DEPARTMENT', 'PROJECT');

-- AlterTable
ALTER TABLE "document_lines" ADD COLUMN     "department_id" UUID,
ADD COLUMN     "project_id" UUID;

-- AlterTable
ALTER TABLE "journal_lines" ADD COLUMN     "department_id" UUID,
ADD COLUMN     "project_id" UUID;

-- CreateTable
CREATE TABLE "dimension_values" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "type" "DimensionType" NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "customer" VARCHAR(200),
    "start_date" DATE,
    "end_date" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dimension_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dimension_values_org_id_type_idx" ON "dimension_values"("org_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "dimension_values_id_org_id_key" ON "dimension_values"("id", "org_id");

-- CreateIndex
CREATE INDEX "journal_lines_org_id_department_id_idx" ON "journal_lines"("org_id", "department_id");

-- CreateIndex
CREATE INDEX "journal_lines_org_id_project_id_idx" ON "journal_lines"("org_id", "project_id");

-- AddForeignKey
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_department_fk" FOREIGN KEY ("department_id", "org_id") REFERENCES "dimension_values"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_project_fk" FOREIGN KEY ("project_id", "org_id") REFERENCES "dimension_values"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_department_fk" FOREIGN KEY ("department_id", "org_id") REFERENCES "dimension_values"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_project_fk" FOREIGN KEY ("project_id", "org_id") REFERENCES "dimension_values"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One code per dimension in an organisation, whatever its case.
CREATE UNIQUE INDEX "dimension_values_code_key" ON "dimension_values"("org_id", "type", upper("code"));

ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_chk" CHECK (
  code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$' AND length(btrim(name)) > 0
  AND (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
  AND (type = 'PROJECT' OR (customer IS NULL AND start_date IS NULL AND end_date IS NULL))
);

-- Values are never deleted (lines point at them) and keep their organisation and type.
CREATE FUNCTION t2t_guard_dimension_value() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Departments and projects are never deleted; make them inactive instead' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.type <> OLD.type OR NEW.created_by_id <> OLD.created_by_id THEN
    RAISE EXCEPTION 'A department or project keeps its organisation and type' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dimension_values_guard BEFORE UPDATE OR DELETE ON "dimension_values" FOR EACH ROW EXECUTE FUNCTION t2t_guard_dimension_value();

-- A line's department must be a department and its project a project.
CREATE FUNCTION t2t_check_line_dimensions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.department_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dimension_values v WHERE v.id = NEW.department_id AND v.type = 'DEPARTMENT') THEN
    RAISE EXCEPTION 'The department on a line must be a department' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dimension_values v WHERE v.id = NEW.project_id AND v.type = 'PROJECT') THEN
    RAISE EXCEPTION 'The project on a line must be a project' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_lines_dimensions BEFORE INSERT OR UPDATE OF department_id, project_id ON "journal_lines" FOR EACH ROW EXECUTE FUNCTION t2t_check_line_dimensions();
CREATE TRIGGER document_lines_dimensions BEFORE INSERT OR UPDATE OF department_id, project_id ON "document_lines" FOR EACH ROW EXECUTE FUNCTION t2t_check_line_dimensions();

ALTER TABLE "dimension_values" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dimension_values" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dimension_values" USING (t2t_rls_bypass() OR org_id = t2t_current_org()) WITH CHECK (t2t_rls_bypass() OR org_id = t2t_current_org());
