import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { NEW_REGIME_2026_27, PF_RATES, PF_WAGE_CEILINGS, ESI_RULES, PT_MAHARASHTRA } from '@talk2tax/tax-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission, RequireFeature } from '../auth/decorators';
import { todayIso } from '../common/dates';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { PayrollService } from './payroll.service';

const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');
const money = z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'Amount in rupees, e.g. "25000" or "25000.50"');
const kind = z.enum(['WAGES', 'EXCLUDED']);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const accounts = z
  .object({
    salaryExpenseAccountId: z.uuid(),
    employerContributionAccountId: z.uuid(),
    netPayAccountId: z.uuid(),
    pfPayableAccountId: z.uuid(),
    esiPayableAccountId: z.uuid(),
    ptPayableAccountId: z.uuid(),
    tdsPayableAccountId: z.uuid(),
  })
  .strict();
const SettingsBody = z.object({ pfEstablishmentCode: optText(40), esiEmployerCode: optText(40), ptRegistration: optText(40), accounts: accounts.optional() }).strict();
const Structure = z
  .object({
    effectiveFrom: isoDate,
    components: z
      .array(z.object({ code: z.string().trim().min(1).max(20), name: z.string().trim().min(1).max(100), kind, monthlyAmount: money }).strict())
      .min(1)
      .max(30),
  })
  .strict();
const EmployeeFields = {
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(200),
  email: z.email().nullable().optional(),
  pan: optText(10),
  dateOfJoining: isoDate,
  dateOfLeaving: isoDate.nullable().optional(),
  workStateCode: z.string().regex(/^\d{2}$/).nullable().optional(),
  ptCategory: z.enum(['GENERAL', 'WOMAN', 'EXEMPT']).optional(),
  pfMember: z.boolean().optional(),
  epsMember: z.boolean().optional(),
  pfOnFullWages: z.boolean().optional(),
  uan: optText(20),
  esiNumber: optText(20),
  priorTaxYear: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  priorIncome: money.optional(),
  priorTds: money.optional(),
};
const EmployeeBody = z.object({ ...EmployeeFields, structure: Structure }).strict();
const EmployeeUpdate = z.object(EmployeeFields).strict();
const RunBody = z.object({ period, payDate: isoDate }).strict();
const RecalcBody = z.object({ payDate: isoDate.optional() }).strict();
const PayslipBody = z
  .object({
    lopDays: z.string().regex(/^\d{1,2}(\.[05])?$/, 'Whole or half days, e.g. "2" or "1.5"'),
    oneOffs: z.array(z.object({ name: z.string().trim().min(1).max(100), kind, amount: money }).strict()).max(10),
  })
  .strict();
const PayBody = z.object({ liability: z.enum(['NET_PAY', 'PF', 'ESI', 'PT', 'TDS']), date: isoDate, bankAccountId: z.uuid(), reference: z.string().trim().min(1).max(100) }).strict();
const VoidBody = z.object({ date: isoDate.optional(), reason: z.string().trim().min(3).max(500) }).strict();

@ApiTags('payroll')
@ApiBearerAuth()
@RequireFeature('PAYROLL')
@Controller('v1/orgs/:orgId/payroll')
export class PayrollController {
  constructor(private readonly p: PayrollService) {}

  @Get('settings')
  @RequirePermission('payroll.read')
  settings(@CurrentOrg() org: OrgContext) {
    return this.p.getSettings(org.id);
  }

  /** Registrations and posting accounts. Without `accounts`, 6100, 6110 and 2410–2414 are used (created if missing). */
  @Put('settings')
  @RequirePermission('payroll.manage')
  @ApiBody({ schema: openApi(SettingsBody) })
  saveSettings(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SettingsBody)) body: z.infer<typeof SettingsBody>) {
    return this.p.saveSettings(org.id, user, body);
  }

  /** The statutory figures the calculation uses, with their sources. */
  @Get('rules')
  @RequirePermission('payroll.read')
  rules() {
    return { pfWageCeilings: PF_WAGE_CEILINGS, pfRates: PF_RATES, esi: ESI_RULES, professionalTax: { '27': PT_MAHARASHTRA }, incomeTax: NEW_REGIME_2026_27 };
  }

  @Get('employees')
  @RequirePermission('payroll.read')
  employees(@CurrentOrg() org: OrgContext) {
    return this.p.listEmployees(org.id);
  }

  @Post('employees')
  @RequirePermission('payroll.manage')
  @ApiBody({ schema: openApi(EmployeeBody) })
  createEmployee(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(EmployeeBody)) body: z.infer<typeof EmployeeBody>) {
    return this.p.createEmployee(org.id, user, body);
  }

  @Get('employees/:employeeId')
  @RequirePermission('payroll.read')
  employee(@CurrentOrg() org: OrgContext, @Param('employeeId', ParseUUIDPipe) id: string) {
    return this.p.getEmployee(org.id, id);
  }

  @Put('employees/:employeeId')
  @RequirePermission('payroll.manage')
  @ApiBody({ schema: openApi(EmployeeUpdate) })
  updateEmployee(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('employeeId', ParseUUIDPipe) id: string, @Body(new ZodPipe(EmployeeUpdate)) body: z.infer<typeof EmployeeUpdate>) {
    return this.p.updateEmployee(org.id, user, id, body);
  }

  /** A salary revision from the first of a month. */
  @Post('employees/:employeeId/salaries')
  @RequirePermission('payroll.manage')
  @ApiBody({ schema: openApi(Structure) })
  addSalary(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('employeeId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Structure)) body: z.infer<typeof Structure>) {
    return this.p.addStructure(org.id, user, id, body);
  }

  @Get('runs')
  @RequirePermission('payroll.read')
  runs(@CurrentOrg() org: OrgContext) {
    return this.p.listRuns(org);
  }

  /** A draft pay run for a month, with a payslip for everyone employed in it who has a salary. */
  @Post('runs')
  @RequirePermission('payroll.manage')
  @ApiBody({ schema: openApi(RunBody) })
  createRun(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(RunBody)) body: z.infer<typeof RunBody>) {
    return this.p.createRun(org, user, body);
  }

  @Get('runs/:runId')
  @RequirePermission('payroll.read')
  run(@CurrentOrg() org: OrgContext, @Param('runId', ParseUUIDPipe) id: string) {
    return this.p.getRun(org, id);
  }

  @Delete('runs/:runId')
  @RequirePermission('payroll.manage')
  deleteRun(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('runId', ParseUUIDPipe) id: string) {
    return this.p.deleteRun(org, user, id);
  }

  @Post('runs/:runId/recalculate')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  @ApiBody({ schema: openApi(RecalcBody) })
  recalculate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('runId', ParseUUIDPipe) id: string, @Body(new ZodPipe(RecalcBody)) body: z.infer<typeof RecalcBody>) {
    return this.p.recalculateRun(org, user, id, body);
  }

  /** Loss-of-pay days and one-off earnings for one employee in a draft. */
  @Put('runs/:runId/payslips/:employeeId')
  @RequirePermission('payroll.manage')
  @ApiBody({ schema: openApi(PayslipBody) })
  updatePayslip(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body(new ZodPipe(PayslipBody)) body: z.infer<typeof PayslipBody>,
  ) {
    return this.p.updatePayslip(org, user, runId, employeeId, body);
  }

  @Get('runs/:runId/payslips/:employeeId')
  @RequirePermission('payroll.read')
  payslip(@CurrentOrg() org: OrgContext, @Param('runId', ParseUUIDPipe) runId: string, @Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.p.getPayslip(org, runId, employeeId);
  }

  /** Post the run: Dr salaries and employer contributions, Cr net pay, PF, ESI, professional tax and TDS payable. Needs journals.post too. */
  @Post('runs/:runId/post')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  post(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('runId', ParseUUIDPipe) id: string) {
    return this.p.postRun(org, user, id);
  }

  @Post('runs/:runId/void')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  @ApiBody({ schema: openApi(VoidBody) })
  voidRun(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('runId', ParseUUIDPipe) id: string, @Body(new ZodPipe(VoidBody)) body: z.infer<typeof VoidBody>) {
    return this.p.voidRun(org, user, id, { date: body.date ?? todayIso(), reason: body.reason });
  }

  /** Pay one liability of a posted run from a bank account: net salaries, PF, ESI, professional tax or TDS. */
  @Post('runs/:runId/payments')
  @RequirePermission('payroll.manage')
  @ApiBody({ schema: openApi(PayBody) })
  pay(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('runId', ParseUUIDPipe) id: string, @Body(new ZodPipe(PayBody)) body: z.infer<typeof PayBody>) {
    return this.p.remit(org, user, id, body);
  }

  @Post('runs/:runId/payments/:paymentId/void')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  @ApiBody({ schema: openApi(VoidBody) })
  voidPayment(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body(new ZodPipe(VoidBody)) body: z.infer<typeof VoidBody>,
  ) {
    return this.p.voidRemittance(org, user, runId, paymentId, { date: body.date ?? todayIso(), reason: body.reason });
  }
}
