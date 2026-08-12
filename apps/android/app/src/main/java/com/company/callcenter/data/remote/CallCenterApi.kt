package com.company.callcenter.data.remote

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import retrofit2.http.Multipart
import retrofit2.http.Part
import okhttp3.MultipartBody

interface CallCenterApi {
    @POST("auth/login")
    suspend fun login(@Body body: LoginRequest): LoginResponse

    @POST("auth/refresh")
    suspend fun refresh(@Body body: RefreshTokenRequest): RefreshTokenResponse

    @POST("auth/logout")
    suspend fun logout(@Body body: RefreshTokenRequest)

    @GET("mobile/bootstrap")
    suspend fun bootstrap(): BootstrapResponse

    @GET("mobile/sync")
    suspend fun sync(@Query("cursor") cursor: String): SyncResponse

    @POST("mobile/assignments/{assignmentId}/phone")
    suspend fun revealPhone(@Path("assignmentId") assignmentId: String): PhoneRevealResponse

    @POST("mobile/calls/{attemptId}/phone")
    suspend fun revealHistoryPhone(@Path("attemptId") attemptId: String): PhoneRevealResponse

    @POST("mobile/call-attempts")
    suspend fun createCallAttempt(@Body body: CallAttemptRequest): CallAttemptResponse

    @POST("mobile/call-attempts/{attemptId}/cancel")
    suspend fun cancelCallAttempt(@Path("attemptId") attemptId: String): CancelCallAttemptResponse

    @Multipart
    @POST("mobile/call-attempts/{attemptId}/recording")
    suspend fun uploadRecording(
        @Path("attemptId") attemptId: String,
        @Part file: MultipartBody.Part,
    ): RecordingUploadResponse

    @POST("mobile/call-attempts/{attemptId}/recording/unsupported")
    suspend fun markRecordingUnsupported(
        @Path("attemptId") attemptId: String,
        @retrofit2.http.Body body: Map<String, String>,
    ): RecordingUnsupportedResponse

    @POST("mobile/call-log-results:batch")
    suspend fun uploadCallResults(@Body body: CallObservationBatch): CallObservationResult

    @POST("mobile/heartbeat")
    suspend fun heartbeat(@Body body: HeartbeatRequest)
}
