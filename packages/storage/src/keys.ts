export const keys = {
  inputGarment: (jobId: string) => `inputs/${jobId}/garment.jpg`,
  output: (jobId: string, format: 'png' | 'webp' = 'png') => `outputs/${jobId}/result.${format}`,
  outputThumb: (jobId: string) => `outputs/${jobId}/result.thumb.jpg`,
  mannequinIntermediate: (jobId: string) => `outputs/${jobId}/mannequin-intermediate.png`,
  merchantCatalogItem: (merchantId: string, id: string) =>
    `merchant-catalog/${merchantId}/${id}/image.jpg`,
  merchantCatalogItemThumb: (merchantId: string, id: string) =>
    `merchant-catalog/${merchantId}/${id}/thumb.jpg`,
  merchantCatalogFlatGarment: (merchantId: string, id: string) =>
    `merchant-catalog/${merchantId}/flat/${id}/garment.jpg`,
  // Not merchant-scoped: one demo object is shared by every assigned merchant.
  demoCatalogItem: (id: string) => `demo-catalog/${id}/image.jpg`,
  demoCatalogItemThumb: (id: string) => `demo-catalog/${id}/thumb.jpg`,
  merchantLogo: (merchantId: string) => `merchant-logo/${merchantId}/logo.jpg`,
  devUpload: (merchantId: string, id: string, ext: string) => `dev/${merchantId}/${id}.${ext}`,
  catalogItem: (typeSlug: string, id: string) => `catalog/${typeSlug}/${id}.jpg`,
  catalogThumb: (typeSlug: string, id: string) => `catalog/${typeSlug}/${id}.thumb.jpg`,
  catalogCategoryThumb: (typeSlug: string, id: string) => `catalog/${typeSlug}/cat-${id}.thumb.jpg`,
  modelFace: (id: string) => `models/faces/${id}.jpg`,
  modelFaceThumb: (id: string) => `models/faces/${id}.thumb.jpg`,
  modelFaceSide: (id: string) => `models/faces/${id}.faceside.jpg`,
  modelBackground: (id: string) => `models/backgrounds/${id}.jpg`,
  modelBackgroundThumb: (id: string) => `models/backgrounds/${id}.thumb.jpg`,
  modelBackgroundComfy: (id: string) => `models/backgrounds/${id}.bgcomfy.jpg`,
  userBackground: (userId: string, id: string) => `user-backgrounds/${userId}/${id}.jpg`,
  userBackgroundThumb: (userId: string, id: string) => `user-backgrounds/${userId}/${id}.thumb.jpg`,
  modelPose: (id: string) => `models/poses/${id}.jpg`,
  modelPoseThumb: (id: string) => `models/poses/${id}.thumb.jpg`,
  modelPoseFaceSide: (id: string) => `models/poses/${id}.faceside.jpg`,
  modelPoseBgComfy: (id: string) => `models/poses/${id}.bgcomfy.jpg`,
  subcategoryThumb: (id: string) => `models/subcategories/${id}.thumb.jpg`,
  subcategoryInstruction: (id: string) => `models/subcategories/${id}.instr.jpg`,
  catalogueTemplateThumb: (id: string) => `models/catalogue-templates/${id}.thumb.jpg`,
  subcategoryTemplate: (id: string) => `models/templates/${id}.jpg`,
  subcategoryTemplateThumb: (id: string) => `models/templates/${id}.thumb.jpg`,
  tryonSample: (categoryId: string, sampleId: string) =>
    `tryon/categories/${categoryId}/${sampleId}.jpg`,
  tryonSampleThumb: (categoryId: string, sampleId: string) =>
    `tryon/categories/${categoryId}/${sampleId}.thumb.jpg`,
  tryonPersonSample: () => `tryon/global/person-sample.jpg`,
  tryonPersonSampleThumb: () => `tryon/global/person-sample.thumb.jpg`,
  tryonGarmentSample: () => `tryon/global/garment-sample.jpg`,
  tryonGarmentSampleThumb: () => `tryon/global/garment-sample.thumb.jpg`,
  sareeModelImage: () => `saree/global/model.jpg`,
  sareeModelImageThumb: () => `saree/global/model.thumb.jpg`,
  sareeSampleImage: () => `saree/global/sample.jpg`,
  sareeSampleImageThumb: () => `saree/global/sample.thumb.jpg`,
  sareeStyle: (id: string) => `saree-styles/${id}.jpg`,
  sampleVideo: (id: string) => `sample-videos/${id}.mp4`,
  sampleVideoThumb: (id: string) => `sample-videos/${id}.thumb.gif`,
  // Single global admin-uploaded video (e.g. app intro/promo clip served to the
  // Android app via GET /v1/config/app-video). Fixed key — a new upload replaces
  // the previous one in place; cache-busting is via the ?v= query param, not the key.
  appVideo: () => `config/app-video.mp4`,
  videoOutput: (jobId: string) => `outputs/${jobId}/result.mp4`,
  supportAttachment: (id: string, ext: string) => `support/${id}.${ext}`,
  invoice: (paymentId: string) => `invoices/${paymentId}.pdf`,
};
