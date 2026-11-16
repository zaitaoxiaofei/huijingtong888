// Reporting versions only; historical order formula versions remain untouched.
export const BILLING_REPORT_VERSIONS=Object.freeze({
 legacy:Object.freeze({projection:'official-net-fees-and-withdrawal-v2',formula:'official-net-fees-and-withdrawal-v2',aiFormula:'official-net-fees-and-withdrawal-ai-v3',disposedReturns:false}),
 disposedReturns:Object.freeze({projection:'official-net-fees-disposed-returns-v4',formula:'official-net-fees-disposed-returns-v4',aiFormula:'official-net-fees-disposed-returns-ai-v5',disposedReturns:true})
});
export const CURRENT_BILLING_REPORT=BILLING_REPORT_VERSIONS.disposedReturns;
