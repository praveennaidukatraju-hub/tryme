package tryme.nice.interactive.viewmodel.Login

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty
import java.io.Serializable

@JsonIgnoreProperties(ignoreUnknown = true)
data class DeviceLoginUser(
    @JsonProperty("id") val id: String = "",
    @JsonProperty("email") val email: String = "",
    @JsonProperty("displayName") val displayName: String? = null,
    @JsonProperty("tier") val tier: String = "",
    @JsonProperty("maxActiveDevices") val maxActiveDevices: Int = 0,
) : Serializable

@JsonIgnoreProperties(ignoreUnknown = true)
data class UserSession(
    @JsonProperty("accessToken") val accessToken: String = "",
    @JsonProperty("refreshToken") val refreshToken: String = "",
    @JsonProperty("user") val user: DeviceLoginUser = DeviceLoginUser(),
) : Serializable