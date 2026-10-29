// SPDX-License-Identifier: AGPL-3.0-only
var workflow,config,scope,starting;
async function startup({rootURI,resourceURI}){
 await Zotero.initializationPromise;await Zotero.uiReadyPromise;
 scope={Zotero,Services,IOUtils,PathUtils,Components,ChromeUtils};const root=rootURI||resourceURI.spec;
 for(const file of ['core','metadata-core','pane-core','public-config','installer','metadata','journal-data','metrics-core','metrics-update-core','metrics-updater','metrics','references-core','companions','reading-pane','enrichment','workflow'])Services.scriptloader.loadSubScript(root+file+'.js',scope);
 config=scope.PublicConfig;await config.initialize(root);await scope.PaperInstaller.initialize(config,root);
 // A new install makes no external translation/data request before first-run consent.
 config.onConfigured=async()=>{if(starting)return starting;if(workflow){
  const enabled=!!Zotero.Prefs.get('paperCompanion.metricsEnabled');
  if(!enabled&&workflow.metrics){await workflow.metrics.stop();workflow.metrics=null;}
  if(enabled&&!workflow.metrics){workflow.metrics=new scope.PaperMetrics();await workflow.metrics.start(workflow,scope.JournalData);await workflow.showColumns();}
  return;
 }starting=(async()=>{
  workflow=new scope.PaperWorkflow();await workflow.start();
  if(Zotero.Prefs.get('paperCompanion.metricsEnabled')){workflow.metrics=new scope.PaperMetrics();await workflow.metrics.start(workflow,scope.JournalData);}
  config.installColumns();await workflow.showColumns();
  workflow.companions=new scope.PaperCompanions();await workflow.companions.start(workflow);
  workflow.readingPane=new scope.PaperReadingPane();await workflow.readingPane.start(workflow);
  workflow.enrichment=new scope.PaperEnrichment();await workflow.enrichment.start(workflow);
 })();try{await starting;}catch(e){await workflow?.stop();workflow=null;throw e;}finally{starting=null;}};
 if(config.enabled){
  if(config.managed){try{const connection=await scope.PaperInstaller.ensureRunning();await config.activateConnection(connection,{managed:true,metrics:!!Zotero.Prefs.get('paperCompanion.metricsEnabled')});}catch(e){Zotero.logError(e);}}
  await config.onConfigured();
 }
}
async function shutdown(){await scope?.PaperInstaller?.stop();await starting;await workflow?.stop();config?.stop();workflow=null;}
function install(){}
function uninstall(){}
