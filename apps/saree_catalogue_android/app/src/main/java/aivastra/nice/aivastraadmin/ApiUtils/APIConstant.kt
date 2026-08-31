package com.example.facewixlatest.ApiUtils

import tryme.nice.trymeadmin.BuildConfig

object APIConstant {
    const val errorSomethingWrong = "Oops! Something went wrong. Please try again."
    const val fileNotSupported = "Selected file not supported. Please try another image."
    const val serverTimeOut = "Server time out"

    const val BASE_URL = BuildConfig.API_BASE_URL

    object API_ENDPOINTS {
        const val DEVICE_LOGIN = "v1/auth/device-login"
        const val DEVICE_LOGIN_FORCE = "v1/auth/device-login/force"
        const val DEVICE_REFRESH = "v1/auth/device-refresh"
        const val DEVICE_LOGOUT = "v1/auth/device-logout"

        const val MERCHANT_CATALOG_SAREE_STYLES = "v1/merchant/catalog/saree-styles"
        const val MERCHANT_CATALOG_SAREE_SUBCATEGORIES = "v1/merchant/catalog/saree-subcategories"
        const val MERCHANT_CATALOG_ITEMS = "v1/merchant/catalog"
        const val MERCHANT_CATALOG_PRESIGN = "v1/merchant/catalog/presign"
        const val MERCHANT_CATALOG_GENERATE = "v1/merchant/catalog/generate"
        const val MERCHANT_CATALOG_GENERATE_2 = "v1/merchant/catalog/generate"
        fun merchantCatalogGenerateStatus(jobId: String) = "v1/merchant/catalog/generate/$jobId"
        const val MERCHANT_CATALOG_IMPORT = "v1/merchant/catalog/import"
        fun merchantCatalogItem(id: String) = "v1/merchant/catalog/$id"
    }

    object Parameter {
        const val AUTHORIZATION = "Authorization"
    }
}
