/**
 * State and union territory codes used by India GST: the first two digits of a
 * GSTIN and the "place of supply" on every invoice.
 *
 * Source: GST state code list published by GSTN (used in GSTIN, e-invoice and
 * e-way bill schemas). Retired codes are left out: 25 (Daman and Diu, merged into
 * 26 in 2020) and 28 (undivided Andhra Pradesh, replaced by 37 in 2014).
 * Verified 2026-11-01.
 */
export interface IndiaState {
  code: string;
  name: string;
  /**
   * Union territories without their own legislature levy UTGST instead of SGST
   * on intra-territory supplies (UTGST Act 2017, section 2(8)).
   */
  levies: 'SGST' | 'UTGST';
}

export const INDIA_STATES: readonly IndiaState[] = Object.freeze([
  { code: '01', name: 'Jammu and Kashmir', levies: 'SGST' },
  { code: '02', name: 'Himachal Pradesh', levies: 'SGST' },
  { code: '03', name: 'Punjab', levies: 'SGST' },
  { code: '04', name: 'Chandigarh', levies: 'UTGST' },
  { code: '05', name: 'Uttarakhand', levies: 'SGST' },
  { code: '06', name: 'Haryana', levies: 'SGST' },
  { code: '07', name: 'Delhi', levies: 'SGST' },
  { code: '08', name: 'Rajasthan', levies: 'SGST' },
  { code: '09', name: 'Uttar Pradesh', levies: 'SGST' },
  { code: '10', name: 'Bihar', levies: 'SGST' },
  { code: '11', name: 'Sikkim', levies: 'SGST' },
  { code: '12', name: 'Arunachal Pradesh', levies: 'SGST' },
  { code: '13', name: 'Nagaland', levies: 'SGST' },
  { code: '14', name: 'Manipur', levies: 'SGST' },
  { code: '15', name: 'Mizoram', levies: 'SGST' },
  { code: '16', name: 'Tripura', levies: 'SGST' },
  { code: '17', name: 'Meghalaya', levies: 'SGST' },
  { code: '18', name: 'Assam', levies: 'SGST' },
  { code: '19', name: 'West Bengal', levies: 'SGST' },
  { code: '20', name: 'Jharkhand', levies: 'SGST' },
  { code: '21', name: 'Odisha', levies: 'SGST' },
  { code: '22', name: 'Chhattisgarh', levies: 'SGST' },
  { code: '23', name: 'Madhya Pradesh', levies: 'SGST' },
  { code: '24', name: 'Gujarat', levies: 'SGST' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', levies: 'UTGST' },
  { code: '27', name: 'Maharashtra', levies: 'SGST' },
  { code: '29', name: 'Karnataka', levies: 'SGST' },
  { code: '30', name: 'Goa', levies: 'SGST' },
  { code: '31', name: 'Lakshadweep', levies: 'UTGST' },
  { code: '32', name: 'Kerala', levies: 'SGST' },
  { code: '33', name: 'Tamil Nadu', levies: 'SGST' },
  { code: '34', name: 'Puducherry', levies: 'SGST' },
  { code: '35', name: 'Andaman and Nicobar Islands', levies: 'UTGST' },
  { code: '36', name: 'Telangana', levies: 'SGST' },
  { code: '37', name: 'Andhra Pradesh', levies: 'SGST' },
  { code: '38', name: 'Ladakh', levies: 'UTGST' },
  { code: '97', name: 'Other Territory', levies: 'UTGST' },
]);

/** Place of supply for a supply to a recipient outside India (export). Not a GSTIN prefix. */
export const FOREIGN_PLACE_OF_SUPPLY = '96';

const BY_CODE = new Map(INDIA_STATES.map((s) => [s.code, s]));

export function indiaState(code: string): IndiaState | undefined {
  return BY_CODE.get(code);
}

export function isPlaceOfSupply(code: string): boolean {
  return code === FOREIGN_PLACE_OF_SUPPLY || BY_CODE.has(code);
}

export function placeOfSupplyName(code: string): string {
  return code === FOREIGN_PLACE_OF_SUPPLY ? 'Outside India (export)' : (BY_CODE.get(code)?.name ?? code);
}
